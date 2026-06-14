"""Phase 3: Agent uploads + sim/test runs API.

Routes (mounted at ``/orgs/{org_id}/agents/{agent_id}``):

  POST   /upload                multipart tarball upload
  GET    /uploads               list uploads (most recent first)
  GET    /uploads/{upload_id}   fetch one
  POST   /sim/runs              trigger a sim run
  GET    /sim/runs              list sim runs
  GET    /sim/runs/{run_id}     fetch one sim run
  POST   /test/runs             trigger a test run
  GET    /test/runs             list test runs
  GET    /test/runs/{run_id}    fetch one test run

Auth
----
``_require_agent_read`` allows org members + superusers. ``_require_agent_write``
restricts to admins/owners. Uploads + run triggers are write actions;
the GETs are read actions.

Execution
---------
Run triggers return immediately with a row in ``pending`` state. The
actual execution is dispatched via FastAPI's ``BackgroundTasks``.
The subprocess adapter is the default; Firecracker awaits the
BandSox protocol extension (see ``src/eden/sim_runner.py``).
"""

from __future__ import annotations

import io
import json
import logging
import os
import tarfile
import time
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi import (
    Path as PathParam,
)
from pydantic import BaseModel

from eden.api.deps import get_current_user
from eden.sim_runner import select_adapter

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/agents/{agent_id}",
    tags=["agent-runs"],
)


# Default upload root — overridable via env var for production.
DEFAULT_UPLOAD_ROOT = os.environ.get(
    "EDEN_UPLOAD_ROOT", "/var/eden/uploads"
)


# ── Pydantic schemas ─────────────────────────────────────────────


class UploadResponse(BaseModel):
    """Result of a successful upload."""

    upload_id: str
    upload_version: int
    code_path: str
    entry_point: str | None = None
    framework: str | None = None
    language: str | None = None
    file_count: int = 0
    total_bytes: int = 0
    eval_yaml: dict | None = None
    uploaded_at: str


class SimRunRequest(BaseModel):
    """Body for triggering a sim or test run."""

    upload_id: str | None = None
    scenario_ids: list[str] | None = None  # if None, all scenarios
    max_episodes: int | None = None
    runner_kind: str | None = None  # "firecracker" | "subprocess"


class SimRunResponse(BaseModel):
    id: str
    org_id: str
    agent_id: str
    upload_id: str
    kind: str  # "sim" | "test"
    status: str
    started_at: str
    finished_at: str | None = None
    duration_ms: int | None = None
    results: dict | None = None
    error: str | None = None
    runner_kind: str | None = None


class SimRunListResponse(BaseModel):
    runs: list[SimRunResponse]
    total: int = 0


# ── Auth helpers ─────────────────────────────────────────────────


async def _require_agent_read(
    org_id: str, agent_id: str, user: dict
) -> None:
    """Verify the user can read agent uploads/runs for the given
    (org, agent) pair. Org members + superusers can read.
    """
    # First check the agent registration exists (defends against
    # scraping non-existent agents).
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is not None:
        row = await client.fetchrow(
            "SELECT 1 FROM agent_registrations WHERE org_id = $1 AND agent_id = $2",
            org_id, agent_id,
        )
        if not row:
            raise HTTPException(
                status_code=404, detail=f"agent {agent_id!r} not registered"
            )

    # Org membership / superuser check
    if user.get("is_superuser", False):
        return
    if user.get("auth_kind") == "api_key" and user.get("org_id") == org_id:
        return
    if org_id in user.get("org_ids", []):
        return
    raise HTTPException(
        status_code=403, detail="User is not a member of this org"
    )


async def _require_agent_write(
    org_id: str, agent_id: str, user: dict
) -> None:
    """Verify the user can write (upload, trigger runs) for the agent.

    Owners and admins only. Members can read but not write.
    """
    # Org membership check first
    if not user.get("is_superuser", False):
        if user.get("auth_kind") == "api_key" and user.get("org_id") != org_id:
            raise HTTPException(
                status_code=403, detail="API key not authorized for this org"
            )
        if org_id not in user.get("org_ids", []):
            raise HTTPException(
                status_code=403, detail="User is not a member of this org"
            )

    # Write requires owner / admin role
    role = user.get("role")
    if role in ("owner", "admin") or user.get("is_superuser", False):
        return
    # API key: assume the key has the right scope; we don't track
    # per-key role granularity here. Real deployment will need a
    # per-key permission field.
    if user.get("auth_kind") == "api_key":
        return
    raise HTTPException(
        status_code=403,
        detail="agents:write requires owner or admin role",
    )


# ── Row → Response helpers ────────────────────────────────────────


def _row_to_upload_response(row: dict) -> UploadResponse:
    eval_yaml = row.get("eval_yaml") or row.get("evalyaml")
    if isinstance(eval_yaml, str):
        try:
            eval_yaml = json.loads(eval_yaml)
        except Exception:  # noqa: BLE001
            eval_yaml = None
    return UploadResponse(
        upload_id=str(row["id"]),
        upload_version=int(row.get("upload_version", 1)),
        code_path=row.get("code_path", ""),
        entry_point=row.get("entry_point"),
        framework=row.get("framework"),
        language=row.get("language"),
        file_count=int(row.get("file_count") or 0),
        total_bytes=int(row.get("total_bytes") or 0),
        eval_yaml=eval_yaml,
        uploaded_at=_iso(row.get("uploaded_at")),
    )


def _row_to_run_response(row: dict) -> SimRunResponse:
    results = row.get("results")
    if isinstance(results, str):
        try:
            results = json.loads(results)
        except Exception:  # noqa: BLE001
            results = None
    return SimRunResponse(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        agent_id=str(row["agent_id"]),
        upload_id=str(row["upload_id"]),
        kind=str(row.get("kind", "sim")),
        status=str(row.get("status", "pending")),
        started_at=_iso(row.get("started_at")),
        finished_at=_iso(row.get("finished_at")) if row.get("finished_at") else None,
        duration_ms=row.get("duration_ms"),
        results=results,
        error=row.get("error"),
        runner_kind=row.get("runner_kind"),
    )


def _iso(ts) -> str:
    if ts is None:
        return ""
    if isinstance(ts, datetime):
        return ts.astimezone(UTC).isoformat()
    return str(ts)


# ── Upload routes ───────────────────────────────────────────────


@router.post("/upload", response_model=UploadResponse)
async def upload_agent_code(
    org_id: str,
    agent_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(..., description="Tarball (tar.gz or zip) of the agent code"),
    user: dict = Depends(get_current_user),
) -> UploadResponse:
    """Receive an agent code tarball, save to filesystem, parse
    ``eden-sim-eval.yaml``, create the upload row.

    Accepts ``.tar.gz``, ``.tgz``, or ``.zip`` archives. The CLI
    produces tarballs via ``eden agent push <dir>``.
    """
    await _require_agent_write(org_id, agent_id, user)

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    # Read the upload into memory (max 50 MB to keep the MVP simple)
    raw = await file.read()
    if len(raw) > 50 * 1024 * 1024:
        raise HTTPException(
            status_code=413, detail="Upload too large (50MB limit for MVP)"
        )

    # Extract to a fresh directory
    upload_id = str(uuid.uuid4())
    code_path = Path(DEFAULT_UPLOAD_ROOT) / org_id / agent_id / upload_id
    code_path.mkdir(parents=True, exist_ok=True)
    file_count, total_bytes = _extract_archive(raw, code_path, file.filename or "")

    # Parse eden-sim-eval.yaml if present
    eval_yaml = _load_eval_yaml(code_path)
    entry_point = None
    framework = None
    language = "python"
    if eval_yaml:
        target = eval_yaml.get("target") or {}
        entry_point = target.get("module")
        framework = eval_yaml.get("framework")

    # Insert the row (DB trigger supersedes prior active upload)
    row = await client.create_agent_upload(
        org_id=org_id,
        agent_id=agent_id,
        code_path=str(code_path),
        entry_point=entry_point,
        framework=framework,
        language=language,
        file_count=file_count,
        total_bytes=total_bytes,
        eval_yaml=eval_yaml,
        uploaded_by=user.get("user_id"),
    )
    return _row_to_upload_response(row)


@router.get("/uploads", response_model=list[UploadResponse])
async def list_uploads(
    org_id: str,
    agent_id: str,
    active_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(get_current_user),
) -> list[UploadResponse]:
    """List uploads for an agent, most-recent first."""
    await _require_agent_read(org_id, agent_id, user)

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    rows = await client.list_agent_uploads(
        org_id=org_id, agent_id=agent_id,
        active_only=active_only, limit=limit,
    )
    return [_row_to_upload_response(r) for r in rows]


@router.get("/uploads/{upload_id}", response_model=UploadResponse)
async def get_upload(
    org_id: str,
    agent_id: str,
    upload_id: str = PathParam(..., description="Upload ID"),
    user: dict = Depends(get_current_user),
) -> UploadResponse:
    """Fetch one upload by id."""
    await _require_agent_read(org_id, agent_id, user)

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    row = await client.get_agent_upload(upload_id)
    if not row or str(row.get("org_id")) != org_id or row.get("agent_id") != agent_id:
        raise HTTPException(status_code=404, detail="Upload not found")
    return _row_to_upload_response(row)


# ── Sim run routes ──────────────────────────────────────────────


@router.post("/sim/runs", response_model=SimRunResponse)
async def trigger_sim_run(
    org_id: str,
    agent_id: str,
    body: SimRunRequest,
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
) -> SimRunResponse:
    """Trigger a sim run. Persists the run row immediately in
    ``pending`` state; the actual execution runs in a background
    task. Clients poll ``GET /sim/runs/{run_id}`` to see status.
    """
    await _require_agent_write(org_id, agent_id, user)

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    # Resolve the upload
    upload = None
    if body.upload_id:
        upload = await client.get_agent_upload(body.upload_id)
        if not upload or upload.get("org_id") != org_id or upload.get("agent_id") != agent_id:
            raise HTTPException(status_code=404, detail="upload_id not found")
    else:
        upload = await client.get_active_upload(
            org_id=org_id, agent_id=agent_id
        )
        if not upload:
            raise HTTPException(
                status_code=400,
                detail="No active upload for this agent. Run "
                       "`eden agent push <dir>` first.",
            )

    # Persist the run row
    row = await client.create_sim_run(
        org_id=org_id,
        agent_id=agent_id,
        upload_id=str(upload["id"]),
        kind="sim",
        user_id=user.get("user_id"),
        runner_kind=body.runner_kind or "subprocess",
    )
    run_id = str(row["id"])

    # Dispatch execution
    background_tasks.add_task(
        _execute_run,
        run_id=run_id,
        org_id=org_id,
        agent_id=agent_id,
        kind="sim",
        code_path=upload["code_path"],
        eval_yaml=upload.get("eval_yaml") or {},
        scenario_ids=body.scenario_ids,
        max_episodes=body.max_episodes,
        runner_kind=body.runner_kind or "subprocess",
    )
    return _row_to_run_response(row)


@router.get("/sim/runs", response_model=SimRunListResponse)
async def list_sim_runs(
    org_id: str,
    agent_id: str,
    status: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(get_current_user),
) -> SimRunListResponse:
    """List sim runs for an agent, most-recent first."""
    await _require_agent_read(org_id, agent_id, user)

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    rows = await client.list_sim_runs(
        org_id=org_id, agent_id=agent_id, kind="sim",
        status=status, limit=limit,
    )
    return SimRunListResponse(
        runs=[_row_to_run_response(r) for r in rows],
        total=len(rows),
    )


@router.get("/sim/runs/{run_id}", response_model=SimRunResponse)
async def get_sim_run(
    org_id: str,
    agent_id: str,
    run_id: str = PathParam(...),
    user: dict = Depends(get_current_user),
) -> SimRunResponse:
    """Fetch one sim run by id."""
    await _require_agent_read(org_id, agent_id, user)

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    row = await client.get_sim_run(run_id)
    if not row or str(row.get("org_id")) != org_id or row.get("agent_id") != agent_id:
        raise HTTPException(status_code=404, detail="sim run not found")
    return _row_to_run_response(row)


# ── Test run routes (same shape, kind="test") ──────────────────


@router.post("/test/runs", response_model=SimRunResponse)
async def trigger_test_run(
    org_id: str,
    agent_id: str,
    body: SimRunRequest,
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
) -> SimRunResponse:
    """Trigger a pytest run against the uploaded agent."""
    await _require_agent_write(org_id, agent_id, user)

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    upload = None
    if body.upload_id:
        upload = await client.get_agent_upload(body.upload_id)
        if not upload or upload.get("org_id") != org_id or upload.get("agent_id") != agent_id:
            raise HTTPException(status_code=404, detail="upload_id not found")
    else:
        upload = await client.get_active_upload(
            org_id=org_id, agent_id=agent_id
        )
        if not upload:
            raise HTTPException(
                status_code=400,
                detail="No active upload for this agent. "
                       "Run `eden agent push <dir>` first.",
            )

    row = await client.create_sim_run(
        org_id=org_id,
        agent_id=agent_id,
        upload_id=str(upload["id"]),
        kind="test",
        user_id=user.get("user_id"),
        runner_kind=body.runner_kind or "subprocess",
    )
    run_id = str(row["id"])
    background_tasks.add_task(
        _execute_run,
        run_id=run_id,
        org_id=org_id,
        agent_id=agent_id,
        kind="test",
        code_path=upload["code_path"],
        eval_yaml=upload.get("eval_yaml") or {},
        scenario_ids=None,
        max_episodes=None,
        runner_kind=body.runner_kind or "subprocess",
    )
    return _row_to_run_response(row)


@router.get("/test/runs", response_model=SimRunListResponse)
async def list_test_runs(
    org_id: str,
    agent_id: str,
    status: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(get_current_user),
) -> SimRunListResponse:
    await _require_agent_read(org_id, agent_id, user)

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    rows = await client.list_sim_runs(
        org_id=org_id, agent_id=agent_id, kind="test",
        status=status, limit=limit,
    )
    return SimRunListResponse(
        runs=[_row_to_run_response(r) for r in rows],
        total=len(rows),
    )


@router.get("/test/runs/{run_id}", response_model=SimRunResponse)
async def get_test_run(
    org_id: str,
    agent_id: str,
    run_id: str = PathParam(...),
    user: dict = Depends(get_current_user),
) -> SimRunResponse:
    await _require_agent_read(org_id, agent_id, user)

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    row = await client.get_sim_run(run_id)
    if not row or str(row.get("org_id")) != org_id or row.get("agent_id") != agent_id:
        raise HTTPException(status_code=404, detail="test run not found")
    return _row_to_run_response(row)


# ── Background execution ────────────────────────────────────────


async def _execute_run(
    *,
    run_id: str,
    org_id: str,
    agent_id: str,
    kind: str,
    code_path: str,
    eval_yaml: dict,
    scenario_ids: list[str] | None,
    max_episodes: int | None,
    runner_kind: str,
) -> None:
    """Run a sim/test in the background. Persists status + results.

    This is a top-level function (not a closure) so FastAPI's
    BackgroundTasks can serialize + schedule it cleanly.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        logger.error("sim_runner: postgres unavailable; run %s stuck in pending", run_id)
        return

    # Filter scenarios if the request specified a subset
    yaml = dict(eval_yaml or {})
    if scenario_ids and yaml.get("scenarios"):
        yaml["scenarios"] = [
            s for s in yaml["scenarios"]
            if s.get("id") in set(scenario_ids)
        ]
    if max_episodes:
        for s in yaml.get("scenarios", []):
            s["max_episodes"] = max_episodes

    # Mark as running
    await client.update_sim_run_status(run_id, status="running")

    t0 = time.time()
    try:
        adapter = select_adapter(preferred=runner_kind)
        upload_path = Path(code_path)
        if kind == "test":
            result = await adapter.run_tests(
                upload_path=upload_path, eval_yaml=yaml,
            )
        else:
            result = await adapter.run_scenarios(
                upload_path=upload_path, eval_yaml=yaml,
            )
        duration_ms = int((time.time() - t0) * 1000)
        await client.update_sim_run_status(
            run_id, status=result.status, duration_ms=duration_ms,
        )
        await client.update_sim_run_result(
            run_id, results=result.to_results_jsonb(),
        )
    except Exception as exc:  # noqa: BLE001
        duration_ms = int((time.time() - t0) * 1000)
        logger.exception("sim_runner: run %s failed", run_id)
        await client.update_sim_run_status(
            run_id, status="error", duration_ms=duration_ms,
            error=f"{type(exc).__name__}: {exc}",
        )


# ── Helpers ──────────────────────────────────────────────────────


def _extract_archive(
    raw: bytes, dest: Path, filename: str
) -> tuple[int, int]:
    """Extract a tarball/zip to ``dest``. Returns (file_count, total_bytes)."""
    name = filename.lower()
    file_count = 0
    total_bytes = 0
    if name.endswith((".tar.gz", ".tgz")) or _is_gzip(raw):
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tf:
            for member in tf.getmembers():
                if not member.isfile():
                    continue
                # Defend against zip-slip
                target = (dest / member.name).resolve()
                if not str(target).startswith(str(dest.resolve())):
                    raise HTTPException(
                        status_code=400,
                        detail=f"unsafe path in archive: {member.name}",
                    )
                target.parent.mkdir(parents=True, exist_ok=True)
                f = tf.extractfile(member)
                if f is None:
                    continue
                target.write_bytes(f.read())
                file_count += 1
                total_bytes += member.size
    elif name.endswith(".zip") or raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                target = (dest / info.filename).resolve()
                if not str(target).startswith(str(dest.resolve())):
                    raise HTTPException(
                        status_code=400,
                        detail=f"unsafe path in archive: {info.filename}",
                    )
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(info.filename))
                file_count += 1
                total_bytes += info.file_size
    else:
        raise HTTPException(
            status_code=400,
            detail="Upload must be a .tar.gz, .tgz, or .zip archive",
        )
    return file_count, total_bytes


def _is_gzip(raw: bytes) -> bool:
    return len(raw) >= 2 and raw[:2] == b"\x1f\x8b"


def _load_eval_yaml(code_path: Path) -> dict | None:
    """Look for an eden-sim-eval.yaml in the extracted code.

    Tries both the root and the ``eden-sims/`` subdirectory so the
    upload works whether the user uploaded the raw dir or the
    output of ``/eden-sim`` (which writes to ``eden-sims/``).
    """
    candidates = [
        code_path / "eden-sim-eval.yaml",
        code_path / "eden-sims" / "eden-sim-eval.yaml",
    ]
    for c in candidates:
        if c.exists():
            try:
                import yaml as _yaml  # type: ignore
                with c.open("r", encoding="utf-8") as f:
                    return _yaml.safe_load(f) or {}
            except ImportError:
                # Fall back to a minimal manual parse
                return _minimal_yaml_parse(c.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                continue
    return None


def _minimal_yaml_parse(text: str) -> dict:
    """Very small fallback YAML parser for the few keys we need.

    PyYAML is the preferred path; this is just to keep the route
    working when PyYAML isn't installed.
    """
    out: dict[str, Any] = {}
    for line in text.splitlines():
        line = line.split("#", 1)[0].rstrip()
        if not line or ":" not in line:
            continue
        k, _, v = line.partition(":")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if v:
            out[k] = v
    return out
