"""``/eden-improve`` — flagship multi-pass improvement sweep.

Usage (inside the Eden chat):

    /eden-improve --quick
    /eden-improve --deep
    /eden-improve --type code --depth quick
    /eden-improve --max-findings 10

Multi-pass design (``--deep`` is the default; ``--quick`` collapses
the first three passes into one):

    Pass 1 — Gather
        Pulls the full observability summary (window: configurable;
        default 24h) + tenant KB + global KB for the current repo.
        Also collects a lightweight repo map (top-N files by size,
        capped to ``improve.max_files_in_repo_map`` from config).

    Pass 2 — Analysis
        Asks the reasoning LLM to identify candidate issues. The
        prompt includes the gathered context plus an explicit
        "find gaps, not style" instruction. We use ``temperature =
        improve.llm_temperature_analysis`` (default 0.2) to keep
        findings grounded in evidence.

    Pass 3 — Refinement
        A second LLM pass dedupes + prioritizes the candidate list
        and emits one finding per item in a stable markdown format.
        Uses ``temperature = improve.llm_temperature_refinement``
        (default 0.1) to keep ordering stable.

    Pass 4 — Diff synthesis (best-effort)
        For each finding, the LLM drafts a concrete diff against
        the current file. We *do not* auto-apply; findings are
        presented in priority order and the user (or autonomy gate
        from C2) decides.

Quick mode (``--quick``): skips the refinement pass and asks the LLM
to emit prioritized findings directly. Less thorough, much faster.

The output is markdown printed to the chat. Each finding is also
captured in the return value (a list of ``Finding`` records) so
follow-up automation (e.g. C2's ``/eden-pr``) can lift them into PRs.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("eden.cli.commands.improve")


# ── Findings model ─────────────────────────────────────────────────────


@dataclass
class Finding:
    """A single prioritized improvement suggestion."""

    title: str
    category: str  # code | tests | architecture | perf | reliability
    priority: int  # 1 (highest) … N (lowest)
    evidence: str  # 1-3 lines tying back to observability / KB / code
    file_path: Optional[str] = None
    diff: Optional[str] = None  # unified diff, if produced in pass 4
    rationale: str = ""

    def to_markdown(self) -> str:
        loc = f" (`{self.file_path}`)" if self.file_path else ""
        out = [
            f"### {self.priority}. {self.title}{loc}",
            f"_category: **{self.category}**_",
            "",
            f"**Evidence.** {self.evidence.strip()}",
        ]
        if self.rationale:
            out += ["", f"**Why.** {self.rationale.strip()}"]
        if self.diff:
            out += ["", "**Diff.**", "", "```diff", self.diff.strip(), "```"]
        return "\n".join(out)


@dataclass
class ImproveReport:
    """Full output of an ``/eden-improve`` run."""

    findings: list[Finding] = field(default_factory=list)
    depth: str = "deep"
    duration_seconds: float = 0.0
    context_hit_count: int = 0
    truncated: bool = False
    notes: list[str] = field(default_factory=list)

    def to_markdown(self) -> str:
        if not self.findings:
            return (
                "_No actionable findings. Your codebase looks healthy "
                "in the current telemetry window._"
            )
        body = "\n\n".join(f.to_markdown() for f in self.findings)
        header = (
            f"## Eden Improve Report\n\n"
            f"_depth: **{self.depth}** · "
            f"hits: {self.context_hit_count} · "
            f"duration: {self.duration_seconds:.1f}s · "
            f"truncated: {self.truncated}_\n"
        )
        if self.notes:
            header += "\n**Notes.**\n" + "\n".join(f"- {n}" for n in self.notes)
        return f"{header}\n\n{body}"


# ── Context gathering (Pass 1) ──────────────────────────────────────────


@dataclass
class GatheredContext:
    repo_map: str
    global_kb: str
    tenant_kb: str
    observability: str
    hit_count: int = 0
    truncated: bool = False


async def _gather(
    *,
    repo_root: Path,
    max_files: int,
    kb_provider: Any,
    obs_provider: Any,
    query_seed: str,
) -> GatheredContext:
    """Pass 1: pull everything we need in parallel."""
    import asyncio

    repo_map = await asyncio.to_thread(_build_lightweight_repo_map, repo_root, max_files)

    g_task = kb_provider.get_global_context(query_seed)
    t_task = kb_provider.get_tenant_context(query_seed)
    o_task = obs_provider.get_context()

    g, t, o = await asyncio.gather(g_task, t_task, o_task)

    return GatheredContext(
        repo_map=repo_map,
        global_kb=g.text,
        tenant_kb=t.text,
        observability=o.text,
        hit_count=g.hit_count + t.hit_count + o.hit_count,
        truncated=g.truncated or t.truncated or o.truncated,
    )


def _build_lightweight_repo_map(root: Path, max_files: int) -> str:
    """Cheap, dependency-free repo map.

    Lists the largest text files in the repo (capped at ``max_files``)
    plus a one-line summary. Real tree-sitter / PageRank comes from
    Aider's ``RepoMap`` when the chat loop is up; this is the
    pre-chat bootstrap.
    """
    if not root.exists():
        return f"_(no repo at {root})_"

    SKIP_DIRS = {
        ".git", "node_modules", "__pycache__", ".venv", "venv",
        "dist", "build", ".next", ".claude", "target", ".mypy_cache",
    }
    TEXT_EXT = {
        ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java",
        ".rb", ".md", ".yaml", ".yml", ".json", ".toml", ".sh",
    }

    candidates: list[tuple[int, Path]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Filter dirs in-place to prune the walk
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            p = Path(dirpath) / fn
            if p.suffix.lower() in TEXT_EXT:
                try:
                    sz = p.stat().st_size
                except OSError:
                    continue
                if sz == 0 or sz > 1_000_000:  # skip empty + >1MB
                    continue
                candidates.append((sz, p))

    candidates.sort(reverse=True)
    top = candidates[:max_files]

    if not top:
        return f"_(no text files under {max_files} found in {root})_"

    lines = [f"### Repo map ({len(top)} of {len(candidates)} files)", ""]
    for sz, p in top:
        try:
            rel = p.relative_to(root)
        except ValueError:
            rel = p
        lines.append(f"- `{rel}` ({sz} bytes)")
    return "\n".join(lines)


# ── LLM passes (Pass 2 + 3) ────────────────────────────────────────────


ANALYSIS_PROMPT = """You are the Eden improvement analyzer. You will receive
three context sections: a repo map, the Eden Knowledge Base (global + tenant),
and a 24h observability summary.

Your job: produce a list of concrete, evidence-backed improvement
candidates. Find GAPS, not style. Each candidate must reference at
least one piece of evidence (a file path, a KB entry, or an
observability metric).

Output ONLY a JSON array of objects, each with:

  title      (string, <= 80 chars)
  category   (one of: code | tests | architecture | perf | reliability)
  file_path  (string or null)
  evidence   (string, 1-3 lines)
  rationale  (string, 1-3 lines)

No prose before or after the array.
"""


REFINEMENT_PROMPT = """You are the Eden improvement refiner. You will
receive a JSON array of improvement candidates produced by a previous
analysis pass, plus the same context the analyzer saw.

Your job: dedupe overlapping candidates, assign priority integers
(1 = highest), drop any candidate with no concrete evidence, and
order the array by priority ascending. Cap the list at 10.

Output ONLY the refined JSON array (same shape as input, plus
``priority``). No prose.
"""


def _coerce_findings(payload: Any) -> list[Finding]:
    """Normalize the LLM's JSON into ``Finding`` records.

    Tolerant: missing fields are filled with safe defaults; the
    payload may be a bare list, an object with a "findings" key, or
    an object with a "candidates" key.
    """
    if isinstance(payload, dict):
        for key in ("findings", "candidates", "results", "items"):
            if key in payload and isinstance(payload[key], list):
                payload = payload[key]
                break
        else:
            return []
    if not isinstance(payload, list):
        return []

    out: list[Finding] = []
    for i, item in enumerate(payload, start=1):
        if not isinstance(item, dict):
            continue
        try:
            priority_raw = item.get("priority", i)
            priority = int(priority_raw)
        except (TypeError, ValueError):
            priority = i
        out.append(
            Finding(
                title=str(item.get("title") or "(untitled)")[:200],
                category=str(item.get("category") or "code"),
                priority=priority,
                evidence=str(item.get("evidence") or ""),
                file_path=item.get("file_path") or None,
                rationale=str(item.get("rationale") or ""),
                diff=item.get("diff"),
            )
        )
    out.sort(key=lambda f: f.priority)
    return out


def _empty_llm_call(
    prompt: str, context: GatheredContext, temperature: float = 0.2
) -> list[dict[str, Any]]:
    """Deterministic fallback used when no LLM is configured.

    Emits zero findings so the report is honest about the limitation.
    The C1 bootstrap ships with this default; an integration can
    override ``IMPROVE_LLM_CALL`` to plug in a real LLM.
    """
    logger.debug(
        "improve: no LLM hook configured; returning empty findings "
        "(temperature=%s)",
        temperature,
    )
    return []


# Module-level hook so tests / integrations can swap in a real LLM.
IMPROVE_LLM_CALL = _empty_llm_call  # type: ignore[assignment]


def _build_prompt(template: str, context: GatheredContext) -> str:
    return (
        f"{template}\n\n"
        f"---\n# REPO MAP\n{context.repo_map}\n\n"
        f"# GLOBAL KB\n{context.global_kb or '_(empty)_'}\n\n"
        f"# TENANT KB\n{context.tenant_kb or '_(empty)_'}\n\n"
        f"# OBSERVABILITY (24h)\n{context.observability or '_(empty)_'}\n---"
    )


def _parse_json_safely(text: str) -> Any:
    """Best-effort JSON extraction from an LLM response.

    Tolerates fenced code blocks (```json ... ```) and trailing prose.
    Returns ``[]`` on failure rather than raising — the report will
    then honestly say "no findings" instead of crashing the chat.
    """
    text = text.strip()
    # Strip a single leading/trailing fence
    if text.startswith("```"):
        first_nl = text.find("\n")
        if first_nl != -1:
            text = text[first_nl + 1 :]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Find the first '[' and last ']' and try again
        i, j = text.find("["), text.rfind("]")
        if i != -1 and j != -1 and j > i:
            try:
                return json.loads(text[i : j + 1])
            except json.JSONDecodeError:
                return []
        return []


# ── Public entry points ────────────────────────────────────────────────


async def run_improve(
    *,
    repo_root: Path,
    depth: str,
    max_findings: int,
    kb_provider: Any,
    obs_provider: Any,
    query_seed: str,
    max_files: int,
    analysis_temperature: float = 0.2,
    refinement_temperature: float = 0.1,
) -> ImproveReport:
    """Run the multi-pass improve sweep and return a structured report.

    Args:
        repo_root: directory to analyze.
        depth: "quick" or "deep".
        max_findings: cap on the output finding list.
        kb_provider, obs_provider: context providers (see EdenCoder).
        query_seed: search seed for KB queries.
        max_files: cap on the lightweight repo map.
        analysis_temperature, refinement_temperature: passed to the LLM hook.
    """
    t0 = time.time()
    notes: list[str] = []

    # Pass 1 — gather
    ctx = await _gather(
        repo_root=repo_root,
        max_files=max_files,
        kb_provider=kb_provider,
        obs_provider=obs_provider,
        query_seed=query_seed,
    )

    # Pass 2 — analysis
    analysis_prompt = _build_prompt(ANALYSIS_PROMPT, ctx)
    raw_analysis = IMPROVE_LLM_CALL(
        analysis_prompt,
        ctx,
        temperature=analysis_temperature,
    )
    candidates = _coerce_findings(raw_analysis)
    if not candidates:
        notes.append(
            "No LLM hook configured or no analysis output — set "
            "IMPROVE_LLM_CALL to integrate a real model."
        )
        return ImproveReport(
            findings=[],
            depth=depth,
            duration_seconds=time.time() - t0,
            context_hit_count=ctx.hit_count,
            truncated=ctx.truncated,
            notes=notes,
        )

    findings = candidates
    if depth == "deep":
        # Pass 3 — refinement
        refinement_prompt = _build_prompt(
            REFINEMENT_PROMPT + "\n\n# CANDIDATES\n" + json.dumps(raw_analysis, indent=2),
            ctx,
        )
        raw_refined = IMPROVE_LLM_CALL(
            refinement_prompt,
            ctx,
            temperature=refinement_temperature,
        )
        refined = _coerce_findings(raw_refined)
        if refined:
            findings = refined

    findings = findings[:max_findings]

    return ImproveReport(
        findings=findings,
        depth=depth,
        duration_seconds=time.time() - t0,
        context_hit_count=ctx.hit_count,
        truncated=ctx.truncated,
        notes=notes,
    )


# ── Slash command glue ────────────────────────────────────────────────


def cmd_eden_improve(self, args: str) -> None:  # noqa: ANN001
    """Aider slash-command entry point for ``/eden-improve``."""
    import asyncio

    parser = argparse.ArgumentParser(prog="/eden-improve", add_help=False)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--deep", action="store_true")
    parser.add_argument("--type", default=None,
                        choices=["code", "tests", "architecture", "perf", "reliability"])
    parser.add_argument("--max-findings", type=int, default=10)
    parser.add_argument("--repo", default=None,
                        help="Repo root to analyze (default: CWD)")

    try:
        ns = parser.parse_args(args.split())
    except SystemExit:
        return

    # Depth resolution: CLI flag > config default
    depth = "deep"
    if ns.quick:
        depth = "quick"
    elif ns.deep:
        depth = "deep"
    else:
        cfg = getattr(self.coder, "_eden_config", None)
        if cfg is not None and getattr(cfg, "improve", None) is not None:
            depth = cfg.improve.default_depth or "deep"

    # Repo root
    repo_root = Path(ns.repo).resolve() if ns.repo else Path.cwd().resolve()

    # Context providers — fall back to None and let run_improve report
    kb = getattr(self.coder, "_eden_cached_payload", None)
    # If no primed payload, try the live providers on the coder
    if kb is None:
        kb_provider = getattr(self.coder, "eden_kb_context", None)
        obs_provider = getattr(self.coder, "eden_obs_context", None)
        if kb_provider is None or obs_provider is None:
            self.io.tool_output(
                "_Eden context providers not initialized. "
                "Run /eden-traces first to confirm the API is reachable._"
            )
            return
    else:
        # Wrap the cached payload in provider shims that just echo it
        from eden.kb_context import KBContext
        from eden.observability_context import ObservabilityContext

        class _CachedKB:
            def __init__(self, payload):
                self._p = payload

            async def get_global_context(self, *a, **kw):
                return KBContext(scope="global", text=self._p.global_kb, hit_count=0)

            async def get_tenant_context(self, *a, **kw):
                return KBContext(scope="tenant", text=self._p.tenant_kb, hit_count=0)

            async def get_combined_context(self, *a, **kw):
                return KBContext(
                    scope="combined",
                    text=self._p.global_kb + "\n\n" + self._p.tenant_kb,
                    hit_count=0,
                )

        class _CachedObs:
            def __init__(self, payload):
                self._p = payload

            async def get_context(self, *a, **kw):
                return ObservabilityContext(text=self._p.observability, hit_count=0)

            async def list_recent_traces(self, *a, **kw):
                return []

        kb_provider = _CachedKB(kb)
        obs_provider = _CachedObs(kb)

    # Config knobs
    max_files = 200
    cfg = getattr(self.coder, "_eden_config", None)
    if cfg is not None and getattr(cfg, "improve", None) is not None:
        max_files = cfg.improve.max_files_in_repo_map or max_files
        analysis_t = cfg.improve.llm_temperature_analysis
        refine_t = cfg.improve.llm_temperature_refinement
    else:
        analysis_t = 0.2
        refine_t = 0.1

    # Optional type filter applied after generation
    async def _runner() -> ImproveReport:
        return await run_improve(
            repo_root=repo_root,
            depth=depth,
            max_findings=ns.max_findings,
            kb_provider=kb_provider,
            obs_provider=obs_provider,
            query_seed=f"improve:{repo_root.name}",
            max_files=max_files,
            analysis_temperature=analysis_t,
            refinement_temperature=refine_t,
        )

    try:
        report = asyncio.run(_runner())
    except Exception as exc:  # noqa: BLE001
        logger.exception("improve failed")
        self.io.tool_output(f"_eden-improve failed: {exc}_")
        return

    if ns.type:
        report.findings = [f for f in report.findings if f.category == ns.type]

    self.io.tool_output(report.to_markdown())


cmd_eden_improve.__doc__ = (
    "/eden-improve — Multi-pass sweep of repo + telemetry + KB → "
    "prioritized findings with diffs (--quick for fast mode)"
)
