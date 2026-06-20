"""PRPatternService — learn the repo's PR conventions from merged PR history.

On first patch + every ``learn()`` call (manual re-mine), the service:

1. Reads the last N merged PRs via the :class:`RepoProvider`
   (``list_pull_requests(state='closed', limit=N)``).
2. For each PR, captures: title, body, labels, reviewers,
   head branch prefix.
3. Calls a T1 model to extract the dominant patterns:
   * ``title_format`` — e.g. ``"[Eden Agent] Fix: <desc>"``,
     ``"fix(<scope>): <desc>"``, or freeform.
   * ``body_template`` — the 4-paragraph ``what/why/what-to-watch``
     template vs. 1-paragraph vs. bullet list.
   * ``common_labels`` — the 5 most-frequent labels across the
     sample.
   * ``common_reviewers`` — the top 5 reviewers by frequency.
   * ``common_branch_prefix`` — the most common
     ``eden/auto-fix-...`` vs ``fix/...`` vs ``feat/...``.

T1 model choice: extraction task, not generation. Keeps cost
low (~10x cheaper than T2) and is fast enough to run inside
the connect flow without blocking.

Persists to ``pr_patterns`` (one row per ``(org_id, repo_id)``).
:class:`PatchGenerator` reads this table to match house style
in the generated PR body. Without it, the agent's PRs look
foreign in the repo and get rejected.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from typing import Any

from eden.code_change._common import _delete_then_insert, _select_one
from eden.optimization.model_router import ModelRouter, PipelineTask

from ._common import _ok_envelope

logger = logging.getLogger(__name__)


DEFAULT_SAMPLE_SIZE = 50
DEFAULT_WINDOW_DAYS = 90


def _build_pattern_extraction_prompt(samples: list[dict[str, Any]]) -> str:
    parts = [
        "You are a PR-convention analyzer. From the sample PRs, "
        "extract the dominant patterns and return ONLY a JSON object:\n",
        "- title_format: string template with <placeholders>\n",
        "- body_template: 'four_paragraph'|'one_paragraph'|'bullets'|'freeform'\n",
        "- common_labels: array of top-5 label strings\n",
        "- common_reviewers: array of top-5 reviewer identifiers\n",
        "- common_branch_prefix: string (e.g. 'eden/auto-fix')\n\n",
        "Sample PRs (number, title, body[:300], labels, reviewers, branch):\n",
    ]
    for pr in samples[:30]:
        parts.append(
            f"#{pr.get('number', '?')}: {pr.get('title', '')}\n"
            f"  body: {(pr.get('body') or '')[:300]}\n"
            f"  labels: {pr.get('labels', [])}\n"
            f"  reviewers: {pr.get('reviewers', [])}\n"
            f"  branch: {pr.get('branch', '')}\n\n"
        )
    parts.append("Return a single JSON object. No prose, no markdown fences.")
    return "".join(parts)


def _parse_extraction_response(raw: str) -> dict[str, Any]:
    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0]
        data = json.loads(cleaned)
        if isinstance(data, dict):
            return data
    except Exception as exc:
        logger.debug("pr_patterns: extraction parse failed: %s", exc)
    return {}


def _top_n(items: list[Any], n: int) -> list[Any]:
    """Top-N by frequency, preserving order."""
    counter: Counter = Counter(items)
    return [item for item, _ in counter.most_common(n)]


class PRPatternService:
    """Learn + maintain the per-repo PR conventions."""

    name = "pr_patterns"

    def __init__(
        self,
        router: ModelRouter | None = None,
        sample_size: int = DEFAULT_SAMPLE_SIZE,
        window_days: int = DEFAULT_WINDOW_DAYS,
    ) -> None:
        self._router = router
        self._sample_size = sample_size
        self._window_days = window_days

    async def learn(
        self,
        org_id: str,
        repo_id: str,
        provider: Any | None = None,
    ) -> dict[str, Any]:
        """Mine the last N merged PRs + extract patterns via T1.

        ``provider`` is the :class:`RepoProvider` (passed in by
        the route handler). When ``None``, returns degraded
        defaults without making any LLM calls.
        """
        title_format = ""
        body_template = ""
        common_labels: list[str] = []
        common_reviewers: list[str] = []
        common_branch_prefix = "eden/auto-fix"
        last_pr_id: str | None = None
        last_pr_number: int | None = None

        if provider is not None:
            try:
                (
                    title_format,
                    body_template,
                    common_labels,
                    common_reviewers,
                    common_branch_prefix,
                    last_pr_id,
                    last_pr_number,
                ) = await self._learn_from_provider(provider)
            except Exception as exc:
                logger.warning(
                    "pr_patterns.learn failed for repo %s: %s",
                    repo_id, exc,
                )

        # Persist (delete-then-insert).
        try:
            await _delete_then_insert(
                org_id,
                "id",
                f"{org_id}|{repo_id}",
                "pr_patterns",
                [
                    "id",
                    "repo_id",
                    "title_format",
                    "body_template",
                    "common_labels",
                    "common_reviewers",
                    "common_branch_prefix",
                    "sample_size",
                    "sample_window_days",
                    "last_mined_from_pr_id",
                    "last_mined_from_pr_number",
                ],
                [
                    f"{org_id}|{repo_id}",
                    repo_id,
                    title_format,
                    body_template,
                    json.dumps(common_labels),
                    json.dumps(common_reviewers),
                    common_branch_prefix,
                    self._sample_size,
                    self._window_days,
                    last_pr_id,
                    last_pr_number,
                ],
            )
        except Exception as exc:
            logger.debug(
                "pr_patterns: persistence failed for %s: %s", repo_id, exc,
            )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "repo_id": repo_id,
                "title_format": title_format,
                "body_template": body_template,
                "common_labels": common_labels,
                "common_reviewers": common_reviewers,
                "common_branch_prefix": common_branch_prefix,
                "last_mined_from_pr_number": last_pr_number,
                "source": "learned" if provider is not None else "defaults",
            },
        )

    async def get_patterns(
        self,
        org_id: str,
        repo_id: str,
    ) -> dict[str, Any]:
        """Return the persisted patterns, or sensible defaults."""
        row = await _select_one(
            org_id,
            "pr_patterns",
            where="repo_id = $2",
            params=(repo_id,),
        )
        if row is None:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "repo_id": repo_id,
                    "title_format": "[Eden Agent] Fix: <short description>",
                    "body_template": "four_paragraph",
                    "common_labels": ["eden-agent", "needs-review"],
                    "common_reviewers": [],
                    "common_branch_prefix": "eden/auto-fix",
                    "source": "defaults",
                },
            )

        def _coerce(raw: Any) -> Any:
            if isinstance(raw, str):
                try:
                    return json.loads(raw)
                except Exception:
                    return raw
            return raw

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "repo_id": repo_id,
                "title_format": row.get("title_format") or "",
                "body_template": row.get("body_template") or "",
                "common_labels": _coerce(row.get("common_labels")) or [],
                "common_reviewers": _coerce(row.get("common_reviewers")) or [],
                "common_branch_prefix": row.get("common_branch_prefix")
                or "eden/auto-fix",
                "last_mined_at": row["last_mined_at"].isoformat()
                if row.get("last_mined_at") else None,
                "last_mined_from_pr_number": row.get("last_mined_from_pr_number"),
                "source": "learned",
            },
        )

    async def _learn_from_provider(
        self, provider: Any,
    ) -> tuple[str, str, list[str], list[str], str, str | None, int | None]:
        """Pull merged PRs, call T1, return extracted patterns."""
        # ``state='closed'`` is the GitHub convention for merged
        # PRs; the local provider also returns merged PRs in
        # ``state='closed'``.
        prs = await provider.list_pull_requests(
            state="closed", limit=self._sample_size,
        )

        # Build a structured sample for the T1 prompt.
        samples: list[dict[str, Any]] = []
        all_labels: list[str] = []
        all_reviewers: list[str] = []
        all_branches: list[str] = []
        last_pr_id: str | None = None
        last_pr_number: int | None = None
        for pr in prs:
            number = getattr(pr, "number", None)
            title = getattr(pr, "title", "") or ""
            body = getattr(pr, "body", "") or ""
            # Provider-side attrs may differ; default to empty.
            labels = list(getattr(pr, "labels", []) or [])
            reviewers = list(getattr(pr, "reviewers", []) or [])
            branch = getattr(pr, "branch", "") or getattr(pr, "head", "") or ""
            samples.append({
                "number": number,
                "title": title,
                "body": body,
                "labels": labels,
                "reviewers": reviewers,
                "branch": branch,
            })
            all_labels.extend(labels)
            all_reviewers.extend(reviewers)
            if branch:
                all_branches.append(branch.split("/", 1)[0] + "/")
            if number is not None and last_pr_number is None:
                last_pr_number = int(number)
                last_pr_id = str(number)

        # Cheap frequency-based extraction (works even without
        # the T1 call).
        common_labels = _top_n(all_labels, 5)
        common_reviewers = _top_n(all_reviewers, 5)
        common_branch_prefix = (
            _top_n(all_branches, 1)[0] if all_branches else "eden/auto-fix"
        )
        title_format = ""
        body_template = ""

        if self._router is not None and samples:
            task = PipelineTask(
                agent="pr_patterns",
                description="Extract repo PR conventions from sample PRs",
                slot="fast",
                output_type="json",
                expected_min_length=20,
                required_format="json",
            )
            # ``aroute`` walks T1 → T2 → T3 from model_router.
            # Slot="fast" pins the start tier to T1
            # (gpt-4o-mini / claude-3-haiku / gemini-2.0-flash).
            response = await self._router.aroute(
                task,
                _build_pattern_extraction_prompt(samples),
                org_id=org_id,
                user_id=None,
                max_tokens=512,
            )
            extracted = _parse_extraction_response(response.content)
            title_format = str(extracted.get("title_format") or "")
            body_template = str(extracted.get("body_template") or "")
            # Prefer the LLM's list when it returns one, fall
            # back to frequency-based counts.
            llm_labels = extracted.get("common_labels") or []
            llm_reviewers = extracted.get("common_reviewers") or []
            if isinstance(llm_labels, list) and llm_labels:
                common_labels = [str(x) for x in llm_labels[:5]]
            if isinstance(llm_reviewers, list) and llm_reviewers:
                common_reviewers = [str(x) for x in llm_reviewers[:5]]
            branch_prefix = extracted.get("common_branch_prefix")
            if isinstance(branch_prefix, str) and branch_prefix:
                common_branch_prefix = branch_prefix

        return (
            title_format,
            body_template,
            common_labels,
            common_reviewers,
            common_branch_prefix,
            last_pr_id,
            last_pr_number,
        )
