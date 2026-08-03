"""Approve flow: N22 gate → materialize diff → static preverify → draft PR (N23).

M15 (§9): when auto-merge eligibility passes, open a non-draft PR and
merge (canary ladder); otherwise the existing draft-PR path is unchanged.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from eden.improvement import plans_repo
from eden.patches.diff_materializer import (
    DiffMaterializeError,
    materialize_unified_diff,
)
from eden.providers import PRCreateRequest, PRProvider

logger = logging.getLogger(__name__)


class ApproveBlockedError(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


async def _resolve_repo_id(
    org_id: str,
    *,
    agent_id: str | None = None,
) -> str | None:
    """Return the active repo_connections id for this org/agent, else None.

    Uses ``agent_id`` to pick that agent's linked repo (one repo per agent).
    Does not treat ``agent_id`` itself as a connection id.
    """
    from eden.providers.factory import resolve_active_repo_id

    return await resolve_active_repo_id(org_id, agent_id=agent_id)


async def _resolve_base_branch(
    org_id: str,
    repo_provider: Any,
    *,
    agent_id: str | None = None,
) -> str:
    """Resolve the PR base branch — never hardcode ``main``."""
    from eden.providers.factory import resolve_pr_base_branch

    return await resolve_pr_base_branch(org_id, repo_provider, agent_id=agent_id)


def _pr_create_failed(info: Any) -> bool:
    """True when create_pr returned a silent failure envelope."""
    state = (getattr(info, "state", None) or "").lower()
    number = int(getattr(info, "number", 0) or 0)
    url = (getattr(info, "url", None) or "").strip()
    return state == "failed" or number == 0 or not url


def _files_to_static_payload(files: list[Any]) -> list[dict[str, Any]]:
    """Normalize materialized FileEntry / dicts for static_check_files."""
    out: list[dict[str, Any]] = []
    for f in files:
        if isinstance(f, dict):
            path = str(f.get("path") or "")
            content = str(f.get("content") or "")
        else:
            path = str(getattr(f, "path", "") or "")
            content = str(getattr(f, "content", "") or "")
        if path:
            out.append({"path": path, "content": content})
    return out


async def _merge_plan_evidence(
    org_id: str,
    plan_id: str,
    patch: dict[str, Any],
) -> dict[str, Any] | None:
    """Merge keys into ``improvement_plans.evidence``.

    Top-level keys use jsonb ``||``. Nested ``auto_merge`` is deep-merged
    so claim seats (``slot_claimed``) and guardian stamps
    (``force_canary_revert``) survive later approve stamps (M15 TOCTOU).
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return await plans_repo.get_plan(org_id, plan_id)
    try:
        am_patch = patch.get("auto_merge") if isinstance(patch, dict) else None
        if isinstance(am_patch, dict):
            # Deep-merge auto_merge, then shallow-merge the rest of patch
            # without replacing the nested object we just built.
            rest = {k: v for k, v in patch.items() if k != "auto_merge"}
            await client.execute(
                """
                UPDATE improvement_plans SET
                    evidence = jsonb_set(
                        COALESCE(evidence, '{}'::jsonb) || $4::jsonb,
                        '{auto_merge}',
                        COALESCE(evidence->'auto_merge', '{}'::jsonb)
                          || $3::jsonb,
                        true
                    ),
                    updated_at = NOW()
                WHERE org_id = $1 AND id = $2::uuid
                """,
                org_id,
                plan_id,
                json.dumps(am_patch, default=str),
                json.dumps(rest, default=str),
            )
        else:
            await client.execute(
                """
                UPDATE improvement_plans SET
                    evidence = COALESCE(evidence, '{}'::jsonb) || $3::jsonb,
                    updated_at = NOW()
                WHERE org_id = $1 AND id = $2::uuid
                """,
                org_id,
                plan_id,
                json.dumps(patch, default=str),
            )
    except Exception as exc:
        logger.debug("approve: merge evidence failed: %s", exc)
    return await plans_repo.get_plan(org_id, plan_id)


def _md_cell(value: Any, limit: int = 160) -> str:
    """One markdown table cell: pipe/newline-safe, truncated, em-dash empty."""
    text = str(value).strip() if value not in (None, "") else ""
    if not text:
        return "—"
    return text.replace("|", "\\|").replace("\n", " ")[:limit]


def _md_status(section: Any) -> str:
    """``status (reason)`` cell from a ``{status, reason}`` evidence dict."""
    if not isinstance(section, dict) or not section.get("status"):
        return "—"
    reason = str(section.get("reason") or "").strip()
    status = str(section.get("status"))
    return _md_cell(f"{status} ({reason})" if reason else status)


def _issue_ref(issue_id: str) -> str:
    """Portal deep link for an issue id; bare code when no base URL."""
    try:
        from eden.config import get_settings

        s = get_settings()
        base = str(
            getattr(s, "portal_base_url", "") or getattr(s, "app_url", "") or ""
        ).rstrip("/")
        if base and "example.com" not in base:
            return f"[{issue_id}]({base}/issues?issue={issue_id})"
    except Exception:  # noqa: BLE001 — cosmetic only
        pass
    return f"`{issue_id}`"


def render_pr_evidence_body(
    plan: dict[str, Any],
    *,
    plan_id: str,
    summary: str,
    static_status: str | None = None,
) -> str:
    """M9 (§4.3): PR body = plan summary + compact evidence table.

    Renders whatever evidence the plan actually carries (M7 replay tier,
    M8 sandbox tests incl. the ``synthesized: true`` marker) and shows
    ``—`` for anything absent — the table never implies a check ran
    when it didn't. Kept compact: humans review this at merge time.

    M12 (§7.2): the rendered body is value-level-redacted at this choke
    point so secret-shaped substrings never reach the public PR.
    """
    from eden.issues.fixture_export import redact_secret_values

    evidence = plan.get("evidence")
    if not isinstance(evidence, dict):
        evidence = {}

    static_cell = _md_cell(static_status or "")
    if static_cell == "—":
        hermetic = evidence.get("hermetic_preverify")
        if isinstance(hermetic, dict):
            static_cell = _md_cell(hermetic.get("status"))

    sandbox = evidence.get("sandbox_tests")
    sandbox_cell = _md_status(sandbox)
    if isinstance(sandbox, dict) and sandbox.get("synthesized"):
        sandbox_cell = f"{sandbox_cell} — `synthesized: true`"

    signature = evidence.get("failure_signature")
    signature_cell = "—"
    if isinstance(signature, dict) and any(signature.values()):
        signature_cell = _md_cell(
            " · ".join(
                str(signature.get(key))
                for key in ("stumble_kind", "failing_span_name", "error_substring")
                if signature.get(key)
            )
        )

    trace_ids = [str(t) for t in (evidence.get("example_trace_ids") or [])[:3]]
    issue_id = str(evidence.get("issue_id") or "").strip()

    rows = [
        ("Evidence tier", f"**{_md_cell(evidence.get('evidence_tier'))}**"),
        ("Static checks", static_cell),
        ("Replay verify", _md_status(evidence.get("replay"))),
        ("Sandbox tests", sandbox_cell),
        ("Failure signature", signature_cell),
        (
            "Example traces",
            ", ".join(f"`{t}`" for t in trace_ids) if trace_ids else "—",
        ),
        ("Issue", _issue_ref(issue_id) if issue_id else "—"),
    ]
    suppress = evidence.get("suppress_reasons") or evidence.get("patch_blocked")
    if suppress:
        rows.append(("Suppress reasons", _md_cell(suppress, limit=200)))
    if str(evidence.get("ci_ingestion") or "") == "unavailable":
        rows.append(("Customer CI", "unavailable (App lacks `checks:read`)"))

    lines = [
        summary,
        "",
        "### Eden evidence",
        "",
        "| Check | Result |",
        "| --- | --- |",
        *[f"| {label} | {value} |" for label, value in rows],
        "",
        f"_Evidence recorded on plan `{plan_id}`; merging schedules the "
        "post-merge regression verify._",
    ]
    # M12 (§7.2) choke point: value-level scan on the full PR body.
    return redact_secret_values("\n".join(lines))


async def _stamp_ci_ingestion_availability(
    org_id: str,
    plan_id: str,
    plan: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """M9 (§4.3): stamp ``ci_ingestion: "unavailable"`` when detectable.

    Best-effort probe of the App *registration* permissions (the only
    permission surface github.py exposes — per-installation acceptance
    is not persisted anywhere, so a stale un-accepted installation is
    NOT detectable here and simply never delivers check webhooks).
    """
    try:
        from eden.config import get_settings

        if not bool(getattr(get_settings(), "ci_ingestion_v1", True)):
            return plan
        from eden.integrations.github import GitHubOAuthClient, is_configured

        if not is_configured():
            return plan
        perms = await GitHubOAuthClient().app_permissions()
        if str(perms.get("checks") or "") not in ("read", "write"):
            merged = await _merge_plan_evidence(
                org_id, plan_id, {"ci_ingestion": "unavailable"}
            )
            return merged or plan
    except Exception as exc:  # noqa: BLE001 — probe must never block PR-open
        logger.debug("approve: ci_ingestion availability probe skipped: %s", exc)
    return plan


async def regenerate_plan_diff_from_static_errors(
    org_id: str,
    plan: dict[str, Any],
    *,
    repo_provider: Any,
    static_errors: list[dict[str, Any]],
    linked_paths: list[str],
) -> dict[str, Any]:
    """Re-run PatchGenerator once with static feedback; update the plan diff.

    Returns ``{status, plan, static_preverify, ...}``.
    """
    from eden.improvement.evidence_plane import format_static_errors_for_prompt
    from eden.patches.patch_generator import PatchGenerator

    plan_id = str(plan.get("id") or "")
    _raw_ev = plan.get("evidence")
    evidence: dict[str, Any] = _raw_ev if isinstance(_raw_ev, dict) else {}
    feedback = format_static_errors_for_prompt(static_errors)
    if not feedback:
        feedback = "Static preverify failed — regenerate a syntactically valid patch."

    linked_files: list[dict[str, str]] = []
    for path in linked_paths[:8]:
        try:
            content = await repo_provider.read_file(path) or ""
        except Exception:
            content = ""
        if content.strip():
            linked_files.append({"path": path, "content": content})

    if not linked_files:
        return {
            "status": "error",
            "error": "static_regenerate_no_linked_files",
            "message": "Cannot regenerate: no base file content available",
        }

    issue_id = str(evidence.get("issue_id") or "").strip()
    rca_id = issue_id or f"plan:{plan_id}"
    example_ids = list(evidence.get("example_trace_ids") or [])
    trace_id = (
        str(example_ids[0])
        if example_ids
        else f"unknown_trace:{issue_id or plan_id}"
    )
    repo_id = await _resolve_repo_id(
        org_id, agent_id=(plan.get("agent_id") or "").strip() or None
    )
    rca_summary = (
        str(plan.get("summary") or "")
        or str(plan.get("title") or "")
        or "Approve-time static preverify failed; regenerate the patch."
    )

    try:
        result = await PatchGenerator().generate(
            org_id=org_id,
            rca_id=rca_id,
            trace_id=trace_id,
            repo_id=str(repo_id or ""),
            rca_summary=rca_summary,
            linked_files=linked_files,
            test_plan=[],
            persist=False,
            static_feedback=feedback,
        )
    except Exception as exc:
        logger.warning("approve: regenerate failed: %s", exc)
        return {
            "status": "error",
            "error": "static_regenerate_failed",
            "message": str(exc)[:400],
        }

    data = result.get("data", {}) if isinstance(result, dict) else {}
    new_diff = str(data.get("diff") or "").strip()
    static_preverify = data.get("static_preverify") or {}
    if not new_diff or data.get("status") in (
        "low_quality",
        "deduplicated",
        "investigation",
    ):
        return {
            "status": "error",
            "error": "static_preverify_failed",
            "message": str(
                data.get("reason") or "regenerate did not produce a clean diff"
            ),
            "static_preverify": static_preverify,
        }

    updated = await plans_repo.update_plan(
        org_id,
        plan_id,
        diff_unified=new_diff,
        diff_edited=True,
        summary=str(data.get("explanation") or plan.get("summary") or "") or None,
        title=str(data.get("description") or plan.get("title") or "") or None,
    )
    updated = await _merge_plan_evidence(
        org_id,
        plan_id,
        {
            "static_preverify": static_preverify or {"status": "passed"},
            "approve_regenerated": True,
            "static_preverify_errors": static_errors,
        },
    )
    return {
        "status": "ok",
        "plan": updated or plan,
        "diff": new_diff,
        "static_preverify": static_preverify,
        "files": data.get("files") or [],
    }


async def approve_plan(
    org_id: str,
    plan_id: str,
    *,
    approved_by: str | None = None,
    provider: PRProvider | None = None,
) -> dict[str, Any]:
    plan = await plans_repo.get_plan(org_id, plan_id)
    if plan is None:
        return {"status": "not_found", "plan_id": plan_id}

    if plan.get("status") not in ("draft", "pending_review", "approved"):
        return {
            "status": "invalid_state",
            "plan_id": plan_id,
            "current_status": plan.get("status"),
        }

    blocked = await _n22_blocked(org_id, plan)
    if blocked:
        raise ApproveBlockedError(blocked)

    _raw_ev = plan.get("evidence")
    evidence: dict[str, Any] = _raw_ev if isinstance(_raw_ev, dict) else {}
    hermetic = evidence.get("hermetic_preverify")
    hermetic_status = None
    if isinstance(hermetic, dict):
        # M7 (§4.1): new plans carry the honest "static_passed" label;
        # legacy plans carry "passed". Both are surfaced verbatim — this
        # is a pass-through, never a gate.
        hermetic_status = hermetic.get("status")

    plan_kind = plan.get("plan_kind") or "code_patch"
    if plan_kind != "code_patch":
        return await _approve_non_code(org_id, plan_id, plan, approved_by=approved_by)

    diff = plan.get("diff_unified") or ""
    if not diff.strip():
        return {"status": "error", "plan_id": plan_id, "error": "empty_diff"}

    # Resolve this agent's linked repo (one repo per agent).
    plan_agent_id = (plan.get("agent_id") or "").strip() or None
    repo_id = await _resolve_repo_id(org_id, agent_id=plan_agent_id)
    if not repo_id:
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "repo_not_connected",
            "message": "Connect a GitHub repo for this agent so Eden can open fix PRs",
        }

    from eden.improvement.evidence_plane import static_check_files
    from eden.providers.factory import (
        get_pr_provider_for_org,
        get_repo_provider_for_org,
    )

    repo_provider = await get_repo_provider_for_org(org_id, agent_id=plan_agent_id)
    try:
        files = await materialize_unified_diff(
            diff,
            read_file=repo_provider.read_file,
        )
    except DiffMaterializeError as exc:
        logger.warning("approve_plan: materialize failed: %s", exc)
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "diff_materialize_failed",
            "message": str(exc),
        }
    if not files:
        return {"status": "error", "plan_id": plan_id, "error": "unparseable_diff"}

    # Free static recheck on live materialized contents (repo may have drifted).
    static_result = static_check_files(_files_to_static_payload(files))
    static_status = str(static_result.get("status") or "passed")
    regenerated = False
    if static_status == "failed":
        linked_paths = [str(getattr(f, "path", "") or "") for f in files]
        linked_paths = [p for p in linked_paths if p]
        regen = await regenerate_plan_diff_from_static_errors(
            org_id,
            plan,
            repo_provider=repo_provider,
            static_errors=list(static_result.get("errors") or []),
            linked_paths=linked_paths,
        )
        if regen.get("status") != "ok":
            return {
                "status": "error",
                "plan_id": plan_id,
                "error": regen.get("error") or "static_preverify_failed",
                "message": regen.get("message")
                or "Static preverify failed and regenerate did not fix it",
                "static_preverify_status": "failed",
                "static_preverify": regen.get("static_preverify") or static_result,
                "hermetic_preverify_status": hermetic_status,
            }
        regenerated = True
        plan = regen.get("plan") or plan
        diff = str(regen.get("diff") or "")
        try:
            files = await materialize_unified_diff(
                diff,
                read_file=repo_provider.read_file,
            )
        except DiffMaterializeError as exc:
            return {
                "status": "error",
                "plan_id": plan_id,
                "error": "diff_materialize_failed",
                "message": str(exc),
                "static_preverify_status": "failed",
            }
        if not files:
            return {
                "status": "error",
                "plan_id": plan_id,
                "error": "unparseable_diff",
                "static_preverify_status": "failed",
            }
        static_result = static_check_files(_files_to_static_payload(files))
        static_status = str(static_result.get("status") or "passed")
        if static_status == "failed":
            return {
                "status": "error",
                "plan_id": plan_id,
                "error": "static_preverify_failed",
                "message": "Regenerated patch still fails free static preverify",
                "static_preverify_status": "failed",
                "static_preverify": static_result,
                "hermetic_preverify_status": hermetic_status,
            }

    try:
        base = await _resolve_base_branch(org_id, repo_provider, agent_id=plan_agent_id)
    except RuntimeError as exc:
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "base_branch_unresolved",
            "message": str(exc),
        }

    if provider is not None:
        pr_provider = provider
    else:
        try:
            pr_provider = await get_pr_provider_for_org(org_id, agent_id=plan_agent_id)
        except Exception as exc:
            from eden.providers.factory import RepoConnectionError

            if isinstance(exc, RepoConnectionError):
                logger.warning("approve_plan: repo connection error: %s", exc)
                return {
                    "status": "error",
                    "plan_id": plan_id,
                    "error": "repo_connection_error",
                    "message": str(exc),
                }
            raise

    branch = f"eden/improve-{plan_id[:12]}"
    title = f"[Eden] {plan.get('title', 'Improvement plan')[:120]}"
    body = plan.get("summary") or f"Eden improvement plan `{plan_id}`"
    # M9 (§4.3): the human merges with proof in view — render the plan
    # evidence table into the PR body (flagged; falls back to summary).
    try:
        from eden.config import get_settings

        if bool(getattr(get_settings(), "pr_evidence_body_v1", True)):
            body = render_pr_evidence_body(
                plan,
                plan_id=plan_id,
                summary=body,
                static_status=static_status,
            )
    except Exception as exc:  # noqa: BLE001 — body render must not block PR
        logger.debug("approve_plan: evidence body render failed: %s", exc)

    # M15 (§9): eligibility gate — when all conditions pass, open
    # non-draft and merge (canary). Otherwise draft-PR flow unchanged.
    from eden.improvement.auto_merge import (
        AutoMergeDecision,
        claim_auto_merge_slot,
        evaluate_auto_merge_eligibility,
        merge_pull_request,
        release_auto_merge_slot,
    )

    auto_decision = await evaluate_auto_merge_eligibility(
        org_id,
        plan,
        provider=pr_provider,
        base=base,
        repo_id=repo_id,
    )
    use_auto_merge = bool(auto_decision.eligible)
    # M15 harden: atomically claim the weekly seat before opening a
    # non-draft PR so two concurrent approves cannot both pass the soft
    # count check and both merge (TOCTOU). Guardian canary reverts
    # (force_canary_revert) do not consume the weekly merge cap.
    slot_claimed = False
    force_revert = bool(
        ((plan.get("evidence") or {}).get("auto_merge") or {}).get(
            "force_canary_revert"
        )
    )
    if use_auto_merge and not force_revert:
        ok, claim_details = await claim_auto_merge_slot(
            org_id,
            plan_id,
            agent_id=plan_agent_id,
            cap=(auto_decision.details or {}).get("weekly_cap"),
        )
        if not ok:
            use_auto_merge = False
            auto_decision = AutoMergeDecision(
                eligible=False,
                reasons=[
                    f"auto_merge_blocked:{claim_details.get('reason', 'weekly_cap')}"
                ],
                blocked_by="weekly_cap",
                details={**(auto_decision.details or {}), **claim_details},
            )
        else:
            slot_claimed = True
            auto_decision.details = {
                **(auto_decision.details or {}),
                **claim_details,
            }

    # Stamp decision reasons onto the plan before opening the PR so the
    # draft fallback still carries ``auto_merge_blocked:*`` evidence.
    try:
        plan_with_am = await _merge_plan_evidence(
            org_id, plan_id, {"auto_merge": auto_decision.to_evidence()}
        )
        if plan_with_am is not None:
            plan = plan_with_am
    except Exception as exc:  # noqa: BLE001
        logger.debug("approve_plan: auto_merge evidence stamp failed: %s", exc)

    req = PRCreateRequest(
        title=title,
        body=body,
        branch=branch,
        base=base,
        draft=not use_auto_merge,
        repo_id=repo_id,
        files=files,
    )

    try:
        info = await pr_provider.create_pr(req)
    except NotImplementedError as exc:
        if slot_claimed:
            await release_auto_merge_slot(org_id, plan_id)
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "provider_not_implemented",
            "message": str(exc),
        }
    except Exception as exc:
        from eden.providers.pr import GitHubPRPermissionError

        if slot_claimed:
            await release_auto_merge_slot(org_id, plan_id)
        logger.warning("approve_plan: PR create failed: %s", exc)
        error = (
            "github_permissions_missing"
            if isinstance(exc, GitHubPRPermissionError)
            else "pr_create_failed"
        )
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": error,
            "message": str(exc),
        }

    if _pr_create_failed(info):
        if slot_claimed:
            await release_auto_merge_slot(org_id, plan_id)
        logger.warning(
            "approve_plan: create_pr returned failure envelope " "(state=%s number=%s url=%r)",
            getattr(info, "state", None),
            getattr(info, "number", None),
            getattr(info, "url", None),
        )
        return {
            "status": "error",
            "plan_id": plan_id,
            "error": "pr_create_failed",
            "message": (
                f"PR create failed (state={getattr(info, 'state', None)!s}, "
                f"number={getattr(info, 'number', None)!s})"
            ),
        }

    opened_branch = info.branch or branch
    updated = await plans_repo.mark_pr_opened(
        org_id,
        plan_id,
        pr_url=info.url,
        pr_number=info.number,
        github_branch=opened_branch,
        approved_by=approved_by,
    )

    # M15 (§9): canary merge — merge immediately, mark merged, schedule
    # the 10-min ``auto_merge:`` verify window. Merge failure leaves the
    # open non-draft PR for a human and stamps the block reason.
    auto_merged = False
    merge_result: dict[str, Any] | None = None
    if use_auto_merge and info.number is not None:
        merge_result = await merge_pull_request(
            pr_provider,
            int(info.number),
            commit_title=title,
        )
        if merge_result.get("ok"):
            auto_merged = True
            try:
                updated = await _merge_plan_evidence(
                    org_id,
                    plan_id,
                    {
                        "auto_merge": {
                            **auto_decision.to_evidence(),
                            "merged": True,
                            "canary": True,
                            "pr_number": info.number,
                        }
                    },
                ) or updated
            except Exception as exc:  # noqa: BLE001
                logger.debug("approve_plan: auto_merge merged stamp failed: %s", exc)
            try:
                merged_plan = await plans_repo.mark_merged(org_id, plan_id)
                if merged_plan is not None:
                    updated = merged_plan
            except Exception as exc:  # noqa: BLE001
                logger.debug("approve_plan: mark_merged failed: %s", exc)
            # Fast verify window — do not wait for the merge webhook.
            try:
                await _queue_verify(
                    org_id,
                    updated or plan,
                    branch=opened_branch,
                    auto_merge_canary=True,
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("approve_plan: auto_merge verify queue failed: %s", exc)
        else:
            block = str(merge_result.get("reason") or "merge_failed")
            if slot_claimed:
                try:
                    await release_auto_merge_slot(org_id, plan_id)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "approve_plan: release auto_merge slot failed: %s", exc
                    )
            try:
                updated = await _merge_plan_evidence(
                    org_id,
                    plan_id,
                    {
                        "auto_merge": {
                            **auto_decision.to_evidence(),
                            "eligible": False,
                            "blocked_by": "merge_failed",
                            "reasons": [f"auto_merge_blocked:{block}"],
                            "merged": False,
                        }
                    },
                ) or updated
            except Exception as exc:  # noqa: BLE001
                logger.debug("approve_plan: merge_failed stamp failed: %s", exc)

    # M9 (§4.3): honest degrade — when the App registration lacks
    # ``checks:read``, customer CI conclusions can never arrive; stamp
    # the plan so its record doesn't imply CI was consulted.
    updated = await _stamp_ci_ingestion_availability(org_id, plan_id, updated)

    # Soft Autonomy Phase 8: NO production-telemetry verify at PR-open
    # for the draft path. Free static preverify already ran above. N01
    # quiet-window verify is scheduled by the GitHub merge webhook via
    # ``queue_verify_for_plan``. (Canary auto-merge schedules above.)
    await _audit_approve(org_id, plan_id, approved_by)

    # Soft Autonomy Phase 6: Slack alert for the opened PR. Approve is a
    # deep link to the portal plan — never an in-Slack action.
    try:
        from eden.services.slack_notify import notify_pr_opened

        await notify_pr_opened(
            org_id,
            plan_id=plan_id,
            pr_url=info.url,
            title=str(plan.get("title") or "Fix PR"),
            agent_id=(str(plan.get("agent_id") or evidence.get("agent_id") or "").strip() or None),
            issue_id=(str(evidence.get("issue_id") or "").strip() or None),
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("approve_plan: slack pr_opened notify failed: %s", exc)

    await _n06_ledger(
        org_id,
        plan_id,
        event_subtype="approve",
        actor_id=approved_by,
        payload={
            "pr_url": info.url,
            "pr_number": info.number,
            "branch": opened_branch,
            "static_preverify_status": static_status,
            "regenerated": regenerated,
            "auto_merged": auto_merged,
            "auto_merge": auto_decision.to_evidence(),
        },
    )

    if auto_merged:
        merge_advice = {
            "verify_timing": "auto_merge_canary",
            "message": (
                "Eden auto-merged this canary PR (M15). A 10-minute "
                "fast verify window is running; guardian may auto-revert "
                "on regression."
            ),
            "static_preverify_status": static_status,
            "auto_merged": True,
        }
        return {
            "plan_id": plan_id,
            "status": "merged",
            "pr_url": info.url,
            "pr_number": info.number,
            "branch": opened_branch,
            "merge_advice": merge_advice,
            "hermetic_preverify_status": hermetic_status,
            "static_preverify_status": static_status,
            "regenerated": regenerated,
            "auto_merged": True,
            "auto_merge": auto_decision.to_evidence(),
            "plan": updated,
        }

    merge_advice = {
        "verify_timing": "post_merge",
        "message": (
            "Safe to merge when ready — Eden schedules the N01 "
            "regression verify automatically when the PR lands."
        ),
        "static_preverify_status": static_status,
        "auto_merged": False,
        "auto_merge": auto_decision.to_evidence(),
    }

    return {
        "plan_id": plan_id,
        "status": "pr_opened",
        "pr_url": info.url,
        "pr_number": info.number,
        "branch": opened_branch,
        "merge_advice": merge_advice,
        "hermetic_preverify_status": hermetic_status,
        "static_preverify_status": static_status,
        "regenerated": regenerated,
        "auto_merged": False,
        "auto_merge": auto_decision.to_evidence(),
        "plan": updated,
    }


async def _approve_non_code(
    org_id: str,
    plan_id: str,
    plan: dict[str, Any],
    *,
    approved_by: str | None = None,
) -> dict[str, Any]:
    """Route non-code plans: F41 promotion, F68 deploy, or advisory-only.

    ``config_change`` / ``advisory`` plans have no apply automation (M6,
    spec §11) — approve records the recommendation to the N06 ledger and
    returns ``advisory_only``.
    """
    plan_kind = plan.get("plan_kind") or ""
    evidence = plan.get("evidence") or {}
    ref_id = (
        evidence.get("nudge_id")
        or evidence.get("prompt_version_id")
        or evidence.get("guardrail_id")
        or evidence.get("ref_id")
        or ""
    )
    if not ref_id:
        source = plan.get("source_ref") or ""
        if ":" in source:
            ref_id = source.split(":", 1)[1]

    if plan_kind in ("config_change", "advisory"):
        # M6 (D10, spec §3.7/§11): advisory-only kinds. Config-apply
        # automation was deliberately pruned — the config surface is too
        # heterogeneous — so approve acknowledges the recommendation,
        # records it to the N06 ledger, and applies nothing.
        updated = await plans_repo.mark_approved(
            org_id,
            plan_id,
            approved_by=approved_by,
            status="approved",
            metadata={"route_status": "advisory_only"},
        )
        await _n06_ledger(
            org_id,
            plan_id,
            event_subtype="advisory_acknowledged",
            actor_id=approved_by,
            payload={
                "plan_kind": plan_kind,
                "title": plan.get("title") or "",
                "summary": plan.get("summary") or "",
                "recommendation": evidence if isinstance(evidence, dict) else {},
            },
        )
        return {
            "plan_id": plan_id,
            "status": "advisory_only",
            "plan_kind": plan_kind,
            "message": (
                "Recommendation acknowledged and recorded to the N06 ledger. "
                "No automated apply path exists for this plan kind — action "
                "is manual by design."
            ),
            "plan": updated,
        }

    kind_map = {
        "nudge_promote": "nudge",
        "prompt_update": "prompt_version",
        "guardrail_tune": "guardrail",
    }
    promo_kind = kind_map.get(plan_kind)
    if not promo_kind:
        return {
            "status": "unsupported_kind",
            "plan_id": plan_id,
            "plan_kind": plan_kind,
            "message": f"Unknown non-code plan kind: {plan_kind}",
        }

    if plan_kind == "prompt_update":
        # Soft Autonomy Phase 4: F68 gateway deploy IS built
        # (eden.prompts.deploy.PromptDeployService) — wire it instead of
        # failing closed. Human Approve is the gate; deploy pins the new
        # version to the target env (default prod) and hot-reloads the
        # gateway filter.
        return await _approve_prompt_update(
            org_id, plan_id, plan, ref_id=str(ref_id), approved_by=approved_by
        )

    if plan_kind == "guardrail_tune":
        # Guardrail tunes route through the F41 promotion queue like
        # nudges — the evidence gate decides shadow → active. Never a
        # silent no-op.
        pass

    candidate_id: str | None = None
    route_status = "promotion_queued"
    message = "Queued in F41 promotion pipeline"

    try:
        from eden.promotion.evidence_gate import EvidenceGate

        gate = EvidenceGate()
        candidate_id = await gate.enqueue(
            org_id,
            kind=promo_kind,
            ref_id=str(ref_id),
            status="pending",
        )
        if candidate_id and plan_kind == "nudge_promote":
            report = await gate.promote_if_passed(org_id, candidate_id)
            if report.passed:
                route_status = "promoted"
                message = "Nudge promoted via F41 evidence gate"
    except Exception as exc:
        logger.warning("approve non-code: F41 enqueue failed: %s", exc)
        return {
            "plan_id": plan_id,
            "status": "error",
            "supported": False,
            "plan_kind": plan_kind,
            "error": "promotion_enqueue_failed",
            "message": f"F41 enqueue unavailable: {exc}",
        }

    if not candidate_id:
        return {
            "plan_id": plan_id,
            "status": "error",
            "supported": False,
            "plan_kind": plan_kind,
            "error": "promotion_enqueue_empty",
            "message": "F41 enqueue returned no candidate id",
        }

    updated = await plans_repo.mark_approved(
        org_id,
        plan_id,
        approved_by=approved_by,
        status="approved",
        metadata={
            "route_status": route_status,
            "promotion_candidate_id": candidate_id,
            "promotion_kind": promo_kind,
            "ref_id": ref_id,
        },
    )
    await _audit_approve(org_id, plan_id, approved_by)

    return {
        "plan_id": plan_id,
        "status": route_status,
        "plan_kind": plan_kind,
        "promotion_candidate_id": candidate_id,
        "message": message,
        "plan": updated,
    }


async def _approve_prompt_update(
    org_id: str,
    plan_id: str,
    plan: dict[str, Any],
    *,
    ref_id: str,
    approved_by: str | None = None,
) -> dict[str, Any]:
    """Deploy a prompt_update plan via F68 PromptDeployService.

    ``ref_id`` is the prompt_versions row id (evidence.prompt_version_id
    or source_ref). Resolves (prompt_name, version) then pins the version
    to the target env (evidence.env, default ``prod``). Fail-closed on
    any resolution error — the portal must never toast success on a no-op.
    """
    if not ref_id:
        return {
            "plan_id": plan_id,
            "status": "error",
            "plan_kind": "prompt_update",
            "error": "missing_prompt_version_ref",
            "message": "Plan has no prompt_version_id evidence to deploy",
        }

    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception as exc:
        return {
            "plan_id": plan_id,
            "status": "error",
            "plan_kind": "prompt_update",
            "error": "db_unavailable",
            "message": str(exc),
        }
    if client is None:
        return {
            "plan_id": plan_id,
            "status": "error",
            "plan_kind": "prompt_update",
            "error": "db_unavailable",
            "message": "Postgres unavailable",
        }

    try:
        row = await client.fetchrow(
            """
            SELECT p.name AS prompt_name, pv.version AS version
            FROM prompt_versions pv
            JOIN prompts p ON p.id = pv.prompt_id
            WHERE pv.id = $1::uuid AND pv.org_id = $2
            """,
            ref_id,
            org_id,
        )
    except Exception as exc:
        logger.warning("approve prompt_update: version lookup failed: %s", exc)
        return {
            "plan_id": plan_id,
            "status": "error",
            "plan_kind": "prompt_update",
            "error": "prompt_version_lookup_failed",
            "message": str(exc),
        }
    if row is None:
        return {
            "plan_id": plan_id,
            "status": "error",
            "plan_kind": "prompt_update",
            "error": "prompt_version_not_found",
            "message": f"prompt_version {ref_id} not found for this org",
        }

    _raw_ev = plan.get("evidence")
    evidence: dict[str, Any] = _raw_ev if isinstance(_raw_ev, dict) else {}
    env = str(evidence.get("env") or "prod")

    try:
        from eden.prompts.deploy import PromptDeployService

        deployed = await PromptDeployService().deploy(
            org_id,
            prompt_name=str(row["prompt_name"]),
            env=env,
            version=int(row["version"]),
            deployed_by=approved_by,
        )
    except Exception as exc:
        logger.warning("approve prompt_update: deploy failed: %s", exc)
        return {
            "plan_id": plan_id,
            "status": "error",
            "plan_kind": "prompt_update",
            "error": "prompt_deploy_failed",
            "message": str(exc),
        }
    if deployed is None:
        return {
            "plan_id": plan_id,
            "status": "error",
            "plan_kind": "prompt_update",
            "error": "prompt_deploy_failed",
            "message": "PromptDeployService returned no result (db unavailable)",
        }

    updated = await plans_repo.mark_approved(
        org_id,
        plan_id,
        approved_by=approved_by,
        status="approved",
        metadata={
            "route_status": "deployed",
            "prompt_name": str(row["prompt_name"]),
            "version": int(row["version"]),
            "env": env,
        },
    )
    await _audit_approve(org_id, plan_id, approved_by)

    return {
        "plan_id": plan_id,
        "status": "deployed",
        "plan_kind": "prompt_update",
        "prompt_name": str(row["prompt_name"]),
        "version": int(row["version"]),
        "env": env,
        "message": (
            f"Deployed {row['prompt_name']} v{row['version']} to {env} via F68"
        ),
        "plan": updated,
    }


async def _n22_blocked(org_id: str, plan: dict[str, Any]) -> str | None:
    try:
        from eden.closed_loop.autonomy_policy import decide, resolve

        policy = await resolve(org_id, plan.get("agent_id"))
        action = "propose_patch"
        plan_kind = plan.get("plan_kind") or "code_patch"
        if plan_kind == "nudge_promote":
            action = "nudge_promote"
        elif plan_kind in ("prompt_update", "guardrail_tune"):
            action = "prompt_canary"
        verdict, reason, _tier = decide(policy, action)
        if verdict == "deny":
            return reason
        if policy.compliance_profile == "hipaa":
            return "HIPAA observe mode — approve disabled"
    except Exception as exc:
        # Fail-closed: never approve when policy resolution/decide throws.
        logger.warning("approve n22 check failed (blocking): %s", exc)
        return f"n22_check_failed:{str(exc)[:160]}"
    return None


async def queue_verify_for_plan(
    org_id: str, plan: dict[str, Any], *, branch: str | None = None
) -> str | None:
    """Public entry point so other callers reuse the approve flow's N01
    verify scheduling instead of standing up a parallel subsystem.

    Used by :func:`approve_plan` itself (PR-open time) and by the
    GitHub webhook (Phase 2b, PR-merge time) when a linked improvement
    plan's PR lands.
    """
    _raw_ev = plan.get("evidence")
    evidence: dict[str, Any] = _raw_ev if isinstance(_raw_ev, dict) else {}
    _raw_am = evidence.get("auto_merge")
    am: dict[str, Any] = _raw_am if isinstance(_raw_am, dict) else {}
    # Explicit canary=True required (M15 harden — no default-True).
    canary = bool(am.get("merged")) and am.get("canary") is True
    return await _queue_verify(
        org_id, plan, branch=branch, auto_merge_canary=canary
    )


async def _queue_verify(
    org_id: str,
    plan: dict[str, Any],
    *,
    branch: str | None = None,
    auto_merge_canary: bool = False,
) -> str | None:
    evidence = plan.get("evidence") or {}
    issue_id = evidence.get("issue_id")
    if not issue_id:
        source = plan.get("source_ref") or ""
        if source.startswith("issue:"):
            issue_id = source.split(":", 1)[1]

    if not issue_id:
        return None

    # M10 (§5.3): the ``merge:<plan_id>`` ref prefix marks a code-merge
    # verify (default 1800s delay / 30min quiet window — unchanged) and
    # lets the verify worker distinguish it from heal fast-path refs.
    # M15 (§9): canary auto-merges use ``auto_merge:<plan_id>`` for the
    # 10-min fast verify window.
    plan_id = str(plan.get("id") or "")
    if auto_merge_canary and plan_id:
        verify_ref = f"auto_merge:{plan_id}"
    elif plan_id:
        verify_ref = f"merge:{plan_id}"
    else:
        verify_ref = branch or plan.get("github_branch") or plan.get("source_ref") or ""

    verify_id: str | None = None
    try:
        from eden.closed_loop.verify import schedule_verify

        # schedule_verify returns the real verification row id (or None).
        verify_id = await schedule_verify(org_id, str(issue_id), ref=verify_ref)
    except Exception as exc:
        logger.debug("approve verify queue failed: %s", exc)
        return None

    if verify_id:
        # M10 (D15): the patch path must move the issue to ``verifying``
        # — without this VERIFY_PASSED's verifying→resolved transition
        # no-ops and the issue stays ``fix_pending`` forever.
        try:
            from eden.closed_loop.events import EventType
            from eden.closed_loop.state_machine import apply_transition

            await apply_transition(
                org_id,
                str(issue_id),
                event_type=EventType.VERIFY_SCHEDULED,
                reason=f"verification scheduled for plan {plan_id or '?'}",
                detail={"plan_id": plan_id, "verification_id": verify_id},
            )
        except Exception as exc:
            logger.debug("approve verify transition failed: %s", exc)
    return verify_id


async def _n06_ledger(
    org_id: str,
    plan_id: str,
    *,
    event_subtype: str,
    actor_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """N06 compliance pack — append-only audit for N20 approve/reject."""
    try:
        from eden.governance.compliance_pack import AgentAuditLedgerWriter

        await AgentAuditLedgerWriter().write(
            org_id,
            event_type="n20_code_patch",
            event_subtype=event_subtype,
            actor_id=actor_id,
            actor_type="user" if actor_id else "system",
            payload={"plan_id": plan_id, **(payload or {})},
            compliance_tags=["soc2", "n20", "n06"],
        )
    except Exception as exc:
        logger.debug("approve n06 ledger failed: %s", exc)


async def reject_plan_audited(
    org_id: str,
    plan_id: str,
    *,
    rejected_by: str | None = None,
    rejection_reason: str | None = None,
) -> dict[str, Any] | None:
    """Reject + N06 ledger (used by improve routes)."""
    updated = await plans_repo.reject_plan(
        org_id,
        plan_id,
        rejected_by=rejected_by,
        rejection_reason=rejection_reason,
    )
    await _n06_ledger(
        org_id,
        plan_id,
        event_subtype="reject",
        actor_id=rejected_by,
        payload={"rejection_reason": rejection_reason or ""},
    )
    return updated


async def _audit_approve(org_id: str, plan_id: str, approved_by: str | None) -> None:
    try:
        from eden.closed_loop.autonomy_policy import audit

        await audit(
            org_id,
            agent_id=None,
            action="approve_improvement_plan",
            tier="auto_code_patch_pr",
            decision="allow",
            reason=f"plan {plan_id} approved by {approved_by or 'unknown'}",
        )
    except Exception:
        pass

    try:
        from eden.llmops.hooks_bus import HookEvent, get_hook_bus

        bus = get_hook_bus()
        await bus.emit(
            HookEvent(
                reason="improvement.plan_approved",
                severity="medium",
                org_id=org_id,
                source={"primary_entity_id": plan_id},
            )
        )
        await bus.emit(
            HookEvent(
                reason="improvement.pr_opened",
                severity="medium",
                org_id=org_id,
                source={"primary_entity_id": plan_id},
            )
        )
    except Exception:
        pass
