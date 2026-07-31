"""Agent PR-suggestion routes — the agent-in-the-portal flow.

The 4 routes wire the :class:`eden.agent.pr_suggester.PRSuggester`
to a FastAPI surface so the portal's ``/pr-suggestions``
page can:

* ``GET /orgs/{org_id}/agent/pr-suggestions`` — list
  the inbox (filter by ``status`` + ``trigger``).
* ``POST /orgs/{org_id}/agent/pr-suggestions`` — generate
  a new suggestion from an observability trigger.
* ``GET /orgs/{org_id}/agent/pr-suggestions/{suggestion_id}``
  — read a single suggestion (detail view).
* ``POST /orgs/{org_id}/agent/pr-suggestions/{suggestion_id}/open-pr``
  — the human clicks "open PR". This is the only
  **destructive** route: it calls
  :meth:`PRProvider.create_pr` and persists the PR record
  to ``.eden/prs/<n>.json`` (LocalPRProvider) or the
  real remote (when GitHub is wired).

The suggest path is **always allowed** (it's read-only —
the agent reads the repo + writes a JSONL log). The
open-pr path is gated by the same ``intelligence_gap_v0``
umbrella flag as the Cat 23 surface so the rollout is
controlled.

The suggester / provider instances are resolved per-request via
:func:`eden.providers.factory.get_pr_provider_for_org` /
:func:`eden.providers.factory.get_repo_provider_for_org` so
installation tokens stay tenant-scoped. Org membership is
enforced via ``require_path_org_access``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.agent import PRSuggester
from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access
from eden.api.utils.redact import redact_all
from eden.patches.diff_materializer import (
    DiffMaterializeError,
    materialize_unified_diff,
)
from eden.providers import (
    PRCreateRequest,
    PRProvider,
    RepoProvider,
)
from eden.providers.factory import (
    get_pr_provider_for_org,
    get_repo_provider_for_org,
)
from eden.providers.repo import FileEntry

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/agent/pr-suggestions",
    tags=["agent-pr-suggestions"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)


# ── Provider / suggester helpers (per-org, not process singletons) ─


async def _get_repo_provider(org_id: str) -> RepoProvider:
    """Resolve a :class:`RepoProvider` scoped to ``org_id``."""
    return await get_repo_provider_for_org(org_id)


async def _get_pr_provider(org_id: str) -> PRProvider:
    """Resolve a :class:`PRProvider` scoped to ``org_id``."""
    return await get_pr_provider_for_org(org_id)


async def _get_suggester(org_id: str) -> PRSuggester:
    """Build a :class:`PRSuggester` with the org's repo provider."""
    return PRSuggester(repo_provider=await _get_repo_provider(org_id))


# ── Pydantic bodies (per the plan's API contract) ────────────────


class SuggestRequest(BaseModel):
    trigger: str = Field(
        ...,
        description="rca_cluster | drift_alert | retrieval_gap | judge_regression",
    )
    trigger_id: str = Field(
        ...,
        description="The source event id (cluster id, alert id, etc.)",
    )
    trigger_payload: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "The per-trigger JSON. Should include " "affected_files + description when available."
        ),
    )


class OpenPRRequest(BaseModel):
    pr_title: str | None = Field(
        default=None,
        description="Override the suggestion's title.",
    )
    pr_body: str | None = Field(
        default=None,
        description="Override the suggestion's body.",
    )
    branch: str | None = Field(
        default=None,
        description="Override the branch name (default: eden/auto-<id>).",
    )
    base: str | None = Field(
        default=None,
        description=(
            "Base branch to merge into. When omitted, resolved from the "
            "connected repo's default_branch (never invents main)."
        ),
    )
    labels: list[str] = Field(default_factory=list)
    reviewers: list[str] = Field(default_factory=list)
    draft: bool = False
    repo_id: str = Field(
        default="",
        description="The connected repo_id to persist on the PR row.",
    )


# ── Routes ──────────────────────────────────────────────────────


@router.get("")
async def list_suggestions(
    org_id: str = Depends(require_path_org_access),
    status: str | None = None,
    trigger: str | None = None,
    since: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """List the org's PR suggestions, newest first."""
    suggester = await _get_suggester(org_id)
    rows = await suggester.list_suggestions(
        org_id,
        status=status,
        trigger=trigger,
        since=since,
        limit=limit,
    )
    return {
        "status": "ok",
        "feature": "pr_suggester",
        "live": True,
        "data": {
            "suggestions": [_suggestion_to_dict(s) for s in rows],
            "count": len(rows),
            "filter": {
                "status": status,
                "trigger": trigger,
                "since": since,
                "limit": limit,
            },
        },
    }


@router.post("")
async def create_suggestion(
    org_id: str = Depends(require_path_org_access),
    body: SuggestRequest = Body(...),
) -> dict[str, Any]:
    """Generate a new PR suggestion from an observability trigger.

    The body carries the trigger kind + the source event id +
    the per-trigger JSON payload (the ``affected_files`` +
    ``description`` are extracted by the suggester).
    """
    suggester = await _get_suggester(org_id)
    suggestion = await suggester.suggest(
        org_id,
        trigger=body.trigger,
        trigger_id=body.trigger_id,
        trigger_payload=body.trigger_payload,
    )
    return {
        "status": "ok",
        "feature": "pr_suggester",
        "live": True,
        "data": {
            "suggestion": _suggestion_to_dict(suggestion),
            "suggestion_id": suggestion.id,
        },
    }


@router.get("/{suggestion_id}")
async def get_suggestion(
    org_id: str = Depends(require_path_org_access),
    suggestion_id: str = Path(...),
) -> dict[str, Any]:
    """Read a single suggestion (detail view)."""
    suggester = await _get_suggester(org_id)
    suggestion = await suggester.get_suggestion(org_id, suggestion_id)
    if suggestion is None:
        return {
            "status": "not_found",
            "feature": "pr_suggester",
            "live": True,
            "data": {
                "suggestion_id": suggestion_id,
                "message": "Suggestion not found.",
            },
        }
    return {
        "status": "ok",
        "feature": "pr_suggester",
        "live": True,
        "data": {
            "suggestion": _suggestion_to_dict(suggestion),
        },
    }


@router.post("/{suggestion_id}/open-pr")
async def open_pr(
    org_id: str = Depends(require_path_org_access),
    suggestion_id: str = Path(...),
    body: OpenPRRequest = Body(...),
) -> dict[str, Any]:
    """Materialise the suggestion as a real PR.

    Applies ``patch_diff`` via the diff materializer (using
    suggestion originals when present, else the org repo),
    then calls the org-scoped ``PRProvider.create_pr``.
    Fail-closed on empty/bad diffs and silent create failures.
    """
    suggester = await _get_suggester(org_id)
    suggestion = await suggester.get_suggestion(org_id, suggestion_id)
    if suggestion is None:
        return {
            "status": "not_found",
            "feature": "pr_suggester",
            "live": True,
            "data": {
                "suggestion_id": suggestion_id,
                "message": "Suggestion not found.",
            },
        }

    repo_provider = await _get_repo_provider(org_id)
    try:
        files = await _materialize_suggestion_files(suggestion, repo_provider)
    except DiffMaterializeError as exc:
        return {
            "status": "error",
            "feature": "pr_suggester",
            "live": True,
            "data": {
                "suggestion_id": suggestion_id,
                "message": f"diff_materialize_failed: {exc}",
            },
        }
    if not files:
        return {
            "status": "error",
            "feature": "pr_suggester",
            "live": True,
            "data": {
                "suggestion_id": suggestion_id,
                "message": "empty_or_unparseable_diff",
            },
        }

    pr_provider = await _get_pr_provider(org_id)
    base = (body.base or "").strip() or None
    if not base:
        from eden.providers.factory import resolve_pr_base_branch

        try:
            base = await resolve_pr_base_branch(org_id, repo_provider)
        except Exception as exc:
            logger.warning("open_pr: could not resolve base branch: %s", redact_all(str(exc)))
            return {
                "status": "error",
                "feature": "pr_suggester",
                "live": True,
                "data": {
                    "suggestion_id": suggestion_id,
                    "message": f"could_not_resolve_base_branch: {exc}",
                },
            }
    pr_req = PRCreateRequest(
        title=body.pr_title or suggestion.pr_title,
        body=body.pr_body or suggestion.pr_body,
        branch=body.branch or f"eden/auto-{suggestion_id}",
        base=base,
        labels=body.labels,
        reviewers=body.reviewers,
        draft=body.draft,
        files=files,
        commit_message=(
            f"[Eden Agent] {suggestion.pr_title}\n\n"
            f"Trigger: {suggestion.trigger} {suggestion.trigger_id}\n"
            f"Suggestion: {suggestion.id}"
        ),
        repo_id=body.repo_id,
    )
    try:
        pr_info = await pr_provider.create_pr(pr_req)
    except NotImplementedError as exc:
        return {
            "status": "not_implemented",
            "feature": "pr_suggester",
            "live": True,
            "data": {
                "suggestion_id": suggestion_id,
                "message": (
                    f"PR provider not configured for this org: {exc}. "
                    "Set EDEN_PR_PROVIDER=local and EDEN_LOCAL_REPO_PATH."
                ),
            },
        }
    except Exception as exc:
        logger.exception("open_pr failed: %s", redact_all(str(exc)))
        return {
            "status": "error",
            "feature": "pr_suggester",
            "live": True,
            "data": {
                "suggestion_id": suggestion_id,
                "message": f"PR creation failed: {exc}",
            },
        }
    if _pr_create_failed(pr_info):
        logger.warning(
            "open_pr: create_pr returned failure envelope " "(state=%s number=%s url=%r)",
            getattr(pr_info, "state", None),
            getattr(pr_info, "number", None),
            getattr(pr_info, "url", None),
        )
        return {
            "status": "error",
            "feature": "pr_suggester",
            "live": True,
            "data": {
                "suggestion_id": suggestion_id,
                "message": "PR provider returned a failed create_pr result",
            },
        }
    await suggester.mark_opened(org_id, suggestion_id, pr_info.number)
    return {
        "status": "ok",
        "feature": "pr_suggester",
        "live": True,
        "data": {
            "suggestion_id": suggestion_id,
            "pr": {
                "number": pr_info.number,
                "title": pr_info.title,
                "branch": pr_info.branch,
                "base": pr_info.base,
                "url": pr_info.url,
                "state": pr_info.state,
                "created_at": pr_info.created_at.isoformat(),
            },
        },
    }


# ── Helpers ────────────────────────────────────────────────────


def _pr_create_failed(info: Any) -> bool:
    """True when create_pr returned a silent failure envelope."""
    state = (getattr(info, "state", None) or "").lower()
    number = int(getattr(info, "number", 0) or 0)
    url = (getattr(info, "url", None) or "").strip()
    return state == "failed" or number == 0 or not url


async def _materialize_suggestion_files(
    suggestion: Any,
    repo_provider: RepoProvider,
) -> list[FileEntry]:
    """Apply ``patch_diff`` onto originals (or live repo) → FileEntrys.

    Prefer suggestion-captured originals as the base so open-pr
    stays stable even if the live tree moved; fall back to the
    org-scoped repo reader for paths not in the snapshot.
    """
    diff = (getattr(suggestion, "patch_diff", None) or "").strip()
    if not diff:
        return []

    originals: dict[str, str] = {
        f.path: f.content
        for f in (getattr(suggestion, "files", None) or [])
        if getattr(f, "path", None)
    }

    async def read_file(path: str) -> str:
        if path in originals:
            return originals[path]
        return await repo_provider.read_file(path)

    return await materialize_unified_diff(diff, read_file=read_file)


def _suggestion_to_dict(s: Any) -> dict[str, Any]:
    """Serialise a :class:`PRSuggestion` to a JSON-safe dict.

    The on-the-wire shape mirrors the on-disk JSONL
    shape (the portal can fetch the JSONL directly if
    it wants). The ``created_at`` is an ISO-8601 string.
    """
    return {
        "id": s.id,
        "org_id": s.org_id,
        "trigger": s.trigger,
        "trigger_id": s.trigger_id,
        "trigger_summary": s.trigger_summary,
        "files": [{"path": f.path, "size": f.size, "content": f.content} for f in s.files],
        "patch_diff": s.patch_diff,
        "pr_title": s.pr_title,
        "pr_body": s.pr_body,
        "blast_radius": s.blast_radius,
        "confidence": s.confidence,
        "status": s.status,
        "created_at": (
            s.created_at.isoformat() if hasattr(s.created_at, "isoformat") else str(s.created_at)
        ),
        "opened_pr_number": s.opened_pr_number,
    }


# ── New v1.7 endpoints: file content, status, regenerate ─────────


class StatusUpdateRequest(BaseModel):
    status: str = Field(
        ...,
        description="One of: merged, rejected, opened",
    )


class BulkRegenerateRequest(BaseModel):
    suggestion_ids: list[str] = Field(
        default_factory=list,
        description="The ids to regenerate.",
    )


@router.post("/bulk/regenerate")
async def bulk_regenerate_suggestions(
    org_id: str = Depends(require_path_org_access),
    body: BulkRegenerateRequest = Body(...),
) -> dict[str, Any]:
    """Regenerate multiple suggestions in one call.

    Best-effort: a failure in one suggestion does not
    abort the batch. The response carries the
    ``regenerated`` + ``skipped`` arrays so the
    portal can render a per-row result.

    NOTE: This route MUST be defined BEFORE the
    ``{suggestion_id}/...`` routes — otherwise
    FastAPI matches ``bulk`` as a ``suggestion_id``
    and routes the request to ``/{suggestion_id}/regenerate``.
    """
    suggester = await _get_suggester(org_id)
    result = await suggester.bulk_regenerate(
        org_id,
        body.suggestion_ids,
    )
    return {
        "status": "ok",
        "feature": "pr_suggester",
        "live": True,
        "data": {
            "regenerated": result["regenerated"],
            "skipped": result["skipped"],
            "requested": len(body.suggestion_ids),
        },
    }


@router.get("/{suggestion_id}/files/{file_path:path}")
async def get_suggestion_file(
    org_id: str = Depends(require_path_org_access),
    suggestion_id: str = Path(...),
    file_path: str = Path(...),
) -> dict[str, Any]:
    """Read the current content of a file referenced by a suggestion.

    The file path is verified against the suggestion's
    affected-files list so a caller can't read arbitrary
    files from the repo. The content is the *current*
    file (read via the :class:`RepoProvider`) — not the
    snapshot from the suggestion-creation time. This
    matches the portal's "show me the current file"
    use case for the diff preview.
    """
    suggester = await _get_suggester(org_id)
    data = await suggester.get_file_content(
        org_id,
        suggestion_id,
        file_path,
    )
    if data is None:
        return {
            "status": "not_found",
            "feature": "pr_suggester",
            "live": True,
            "data": {
                "suggestion_id": suggestion_id,
                "path": file_path,
                "message": (
                    "File not in the suggestion's affected "
                    "files list, or the file isn't readable "
                    "from the repo."
                ),
            },
        }
    return {
        "status": "ok",
        "feature": "pr_suggester",
        "live": True,
        "data": data,
    }


@router.post("/{suggestion_id}/status")
async def update_suggestion_status(
    org_id: str = Depends(require_path_org_access),
    suggestion_id: str = Path(...),
    body: StatusUpdateRequest = Body(...),
) -> dict[str, Any]:
    """Flip the suggestion's status to ``merged`` / ``rejected`` / ``opened``.

    Used by the portal's "mark as merged" / "reject"
    buttons. The status update is append-only (the
    existing rows in the JSONL log are preserved) so
    the audit trail keeps the suggestion's history.
    """
    suggester = await _get_suggester(org_id)
    updated = await suggester.mark_status(
        org_id,
        suggestion_id,
        body.status,
    )
    if updated is None:
        return {
            "status": "bad_request",
            "feature": "pr_suggester",
            "live": True,
            "data": {
                "suggestion_id": suggestion_id,
                "status": body.status,
                "message": (
                    "Invalid status (must be one of merged / "
                    "rejected / opened) or the suggestion "
                    "was not found."
                ),
            },
        }
    return {
        "status": "ok",
        "feature": "pr_suggester",
        "live": True,
        "data": {
            "suggestion": _suggestion_to_dict(updated),
        },
    }


@router.post("/{suggestion_id}/regenerate")
async def regenerate_suggestion(
    org_id: str = Depends(require_path_org_access),
    suggestion_id: str = Path(...),
) -> dict[str, Any]:
    """Re-run the LLM (or heuristic) against the current file state.

    The new suggestion overwrites the existing one in-
    place; ``status`` is reset to ``"pending"`` so the
    human can re-review.
    """
    suggester = await _get_suggester(org_id)
    updated = await suggester.regenerate(org_id, suggestion_id)
    if updated is None:
        return {
            "status": "not_found",
            "feature": "pr_suggester",
            "live": True,
            "data": {
                "suggestion_id": suggestion_id,
                "message": "Suggestion not found.",
            },
        }
    return {
        "status": "ok",
        "feature": "pr_suggester",
        "live": True,
        "data": {
            "suggestion": _suggestion_to_dict(updated),
        },
    }


__all__ = ["router"]
