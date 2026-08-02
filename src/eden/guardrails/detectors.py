"""Runtime Protection & Guardrails (Cat 15) — detection primitives.

Four services:

* :class:`PromptInjectionDetector` — Galileo-style injection
  scan. Deterministic regex + heuristic pattern set, 95%
  accuracy on a synthetic test set is the design target.
* :class:`PIIFirewall` — Lunary-style redaction. Reuses the
  existing :data:`DEFAULT_PII_PATTERNS` from
  :mod:`eden.services.governance_intel._common` (the Cat 10
  SecurityScanner uses the same set) and respects any
  per-tenant overrides in ``org_pii_policies``.
* :class:`HallucinationBlocker` — Galileo-style output check.
  v0 ships deterministic heuristics (refusal phrases, n-gram
  overlap with the source) — the SLM-as-judge path is the
  v1.4 SLM Initiative.
* :class:`LLMFirewall` — Lunary-style *pre*-LLM-call
  firewall. Runs the input through the injection detector and
  the PII firewall; if either fires, the prompt is rejected
  before it leaves the customer's trust boundary.

Closed-loop wiring: the detectors do not fire any hook on
their own — they return a verdict and the
:class:`InterventionEngine` aggregates + logs the result.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from .policy import (
    ACTION_RANK,
    VALID_ACTIONS,
    _fetch_policies,
    _ok_envelope,
)

logger = logging.getLogger(__name__)


# ─── Prompt-injection pattern set ────────────────────────────────

#: A conservative, deterministic pattern set for prompt
#: injection. Each pattern is a compiled, case-insensitive
#: regex. The set covers the well-known "ignore previous
#: instructions" / "you are now X" / "system: " prompt
#: leak / role hijack / instruction override classes.
#:
#: The patterns are intentionally explicit — false positives
#: on legitimate business text are worse than false negatives.
#: The v1.4 SLM judge catches what this set misses.
INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"\bignore\s+(?:all\s+|the\s+|any\s+|every\s+|your\s+|previous\s+|"
        r"prior\s+|above\s+)?(?:previous|prior|earlier|above|system|"
        r"original|initial|given|prior|above)\s+"
        r"(?:instructions?|prompts?|rules?|directives?|context|"
        r"messages?|content|constraints?)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:disregard|forget|override|bypass|skip|drop|abandon|"
        r"throw\s+away)\s+(?:all\s+|the\s+|any\s+|every\s+|your\s+|"
        r"previous\s+|prior\s+|above\s+)?(?:previous|prior|earlier|"
        r"above|system|original|initial|given|prior|above|"
        r"safety|ethical|moral)\s+"
        r"(?:instructions?|prompts?|rules?|directives?|context|"
        r"messages?|content|constraints?|guidelines?|safeguards?)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\byou\s+are\s+now\s+(?:a|an|the)?\s*"
        r"(?:DAN|evil|unfiltered|jailbroken|unrestricted|unethical|"
        r"amoral|new\s+persona|"
        r"do\s+anything\s+now|chatgpt\s+with\s+no\s+limits|"
        r"developer\s+mode|god\s+mode)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:pretend|act|behave|respond|answer)\s+(?:as\s+|like\s+|"
        r"to\s+be\s+|that\s+you\s+are\s+)?(?:a|an|the)?\s*"
        r"(?:evil|unethical|unfiltered|jailbroken|unrestricted|"
        r"developer\s+mode|system\s+admin|root|administrator|"
        r"supervisor|operator)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bsystem\s*(?:prompt|message|role|context|instructions?)\s*:"
        r"\s*[\"']?",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bnew\s+(?:instructions?|rules?|directives?|system\s+prompt)\s*:"
        r"\s*[\"']?",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:print|reveal|show|tell|leak|dump|disclose|expose|share)\s+"
        r"(?:your\s+|the\s+|all\s+)?(?:system|hidden|secret|internal|"
        r"original|initial|prior)\s+"
        r"(?:prompt|instructions?|rules?|message|context|configuration)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bdo\s+not\s+(?:tell|inform|let|alert|warn|notify|mention|"
        r"disclose|reveal)\s+the\s+user\b",
        re.IGNORECASE,
    ),
)

#: Threshold for "is this an injection?". A single match is
#: enough — the patterns are conservative enough that one hit
#: is high-signal. A future SLM judge would lower this to
#: e.g. ``0.05`` and require a confidence score.
_INJECTION_MIN_HITS = 1


# ─── Hallucination heuristics ────────────────────────────────────

#: Refusal phrases that the Cat 3 hallucination judge treats as
#: "the model couldn't answer" — high-recall, low-precision.
REFUSAL_PHRASES: tuple[str, ...] = (
    "i don't know",
    "i cannot answer",
    "i'm not sure",
    "i am not sure",
    "as an ai",
    "as a language model",
    "i don't have access to",
    "i do not have access to",
    "i'm unable to",
    "i am unable to",
    "sorry, i cannot",
    "sorry, i can't",
)


# ─── PromptInjectionDetector ─────────────────────────────────────


class PromptInjectionDetector:
    """Galileo-style prompt-injection scan.

    The detector is a deterministic regex scan over
    :data:`INJECTION_PATTERNS`. v0 ships the conservative
    pattern set; the v1.4 SLM judge (Qwen 3.5 4B LoRA head)
    will replace it with a learned classifier behind the
    same surface.

    Returns ``data: {"matches": [...], "verdict": "allow|warn|block"}``.
    The verdict follows the org's policy (default
    ``action='block'`` for prompt_injection).
    """

    name = "prompt_injection_detector"

    async def scan(
        self,
        org_id: str,
        *,
        text: str,
    ) -> dict[str, Any]:
        """Scan ``text`` for prompt-injection patterns.

        Returns the list of matched patterns + the verdict
        derived from the org's prompt_injection policy (default
        action ``block`` if no policy exists).
        """
        if not isinstance(text, str) or not text:
            return _ok_envelope(
                self.name,
                {"matches": [], "verdict": "allow", "score": 0.0},
            )

        matches: list[dict[str, Any]] = []
        for pat in INJECTION_PATTERNS:
            for m in pat.finditer(text):
                matches.append(
                    {
                        "pattern": pat.pattern[:80],
                        "match": m.group(0)[:200],
                        "offset": m.start(),
                    }
                )
                if len(matches) >= 8:
                    # Cap the matches list — the response is
                    # for debugging, not for an exhaustive dump.
                    break
            if len(matches) >= 8:
                break

        # Default action for prompt_injection is ``block`` — the
        # org can override via the policy's ``action`` field.
        action = "block"
        try:
            policies = await _fetch_policies(org_id, status="active")
        except Exception:  # pragma: no cover - defensive
            policies = []
        for p in policies:
            if p.get("type") == "prompt_injection":
                p_action = p.get("action")
                if p_action in VALID_ACTIONS:
                    action = p_action
                break

        score = 1.0 if matches else 0.0
        verdict = action if len(matches) >= _INJECTION_MIN_HITS else "allow"

        # Phase A.9: persist the scan to intervention_log so the
        # portal's "Recent injection attempts" feed can render it.
        # Best-effort — a logging failure must not break the scan.
        if matches:
            try:
                from eden.guardrails.intervention import _log_intervention
                await _log_intervention(
                    org_id, policy_id=None, trace_id=None,
                    verdict=verdict,
                    action_taken=f"injection_{verdict}",
                    reason=f"Matched {len(matches)} injection pattern(s)",
                )
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("guardrails: scan log failed: %s", exc)

        return _ok_envelope(
            self.name,
            {"matches": matches, "verdict": verdict, "score": score},
        )


# ─── PIIFirewall ─────────────────────────────────────────────────


class PIIFirewall:
    """Lunary-style PII redaction.

    Reuses :data:`DEFAULT_PII_PATTERNS` from Cat 10 (the
    SecurityScanner uses the same set) so a customer who has
    not configured ``org_pii_policies`` still gets a
    conservative baseline. The firewall redacts the matched
    substrings with a type-tagged placeholder (e.g.
    ``[REDACTED:SSN]``) — the same convention the Cat 10
    scanner uses for the audit log.

    The policy ``spec`` is ``{"patterns": ["ssn", "credit_card"]}``
    to override the default. Unknown pattern names are
    silently dropped.
    """

    name = "pii_firewall"

    async def redact(
        self,
        org_id: str,
        *,
        text: str,
    ) -> dict[str, Any]:
        """Redact PII in ``text`` for the org.

        Returns ``data: {"redacted": "...", "matches": [...]}``.
        ``matches`` lists each redacted region with the pattern
        name + start/end offset.
        """
        if not isinstance(text, str) or not text:
            return _ok_envelope(
                self.name,
                {"redacted": text or "", "matches": []},
            )

        # Default pattern set (shared with Cat 10)
        from eden.services.governance_intel._common import (
            DEFAULT_PII_PATTERNS,
        )

        patterns = dict(DEFAULT_PII_PATTERNS)
        # Apply per-policy overrides
        try:
            policies = await _fetch_policies(org_id, status="active")
        except Exception:  # pragma: no cover - defensive
            policies = []
        active_patterns: list[str] | None = None
        for p in policies:
            if p.get("type") == "pii_redaction":
                spec = p.get("spec") or {}
                active_patterns = spec.get("patterns")
                break

        if active_patterns is not None:
            patterns = {
                k: v for k, v in patterns.items() if k in active_patterns
            }
        if not patterns:
            return _ok_envelope(
                self.name,
                {"redacted": text, "matches": []},
            )

        matches: list[dict[str, Any]] = []
        compiled: list[tuple[str, re.Pattern[str]]] = []
        for name, pat in patterns.items():
            try:
                compiled.append((name, re.compile(pat)))
            except re.error as exc:  # pragma: no cover - defensive
                logger.debug("pii_firewall: bad pattern %s: %s", name, exc)
        if not compiled:
            return _ok_envelope(
                self.name,
                {"redacted": text, "matches": []},
            )

        # Find all matches across patterns, sort by start, then
        # redact in reverse order so the offsets stay stable.
        all_hits: list[tuple[int, int, str]] = []
        for name, rx in compiled:
            for m in rx.finditer(text):
                all_hits.append((m.start(), m.end(), name))
        all_hits.sort(key=lambda t: (t[0], -t[1]))

        # Drop overlapping hits (keep the first).
        non_overlap: list[tuple[int, int, str]] = []
        cursor = -1
        for start, end, name in all_hits:
            if start < cursor:
                continue
            non_overlap.append((start, end, name))
            cursor = end

        redacted = text
        for start, end, name in sorted(
            non_overlap, key=lambda t: -t[0]
        ):
            matches.append(
                {
                    "pattern": name,
                    "start": start,
                    "end": end,
                    "placeholder": f"[REDACTED:{name.upper()}]",
                }
            )
            redacted = redacted[:start] + f"[REDACTED:{name.upper()}]" + redacted[end:]

        return _ok_envelope(
            self.name,
            {"redacted": redacted, "matches": matches},
        )


# ─── HallucinationBlocker ────────────────────────────────────────


class HallucinationBlocker:
    """Galileo-style output check.

    v0 ships two deterministic heuristics:

    * **Refusal detection** — if the candidate contains a
      :data:`REFUSAL_PHRASES` substring, the candidate is
      considered "model refused" — neither grounded nor
      hallucinated; we return ``verdict='allow'`` (the org
      can wire a Cat 3 judge to score these as failures if
      they want).
    * **N-gram overlap with the source context** — the
      candidate's trigrams that don't appear in the context
      are counted. If ``overlap_ratio < 0.2`` we treat the
      candidate as ungrounded and return ``verdict='block'``
      (configurable via the policy's ``action`` field).

    The v1.4 SLM judge will replace this with a learned
    classifier behind the same surface.
    """

    name = "hallucination_blocker"

    async def check(
        self,
        org_id: str,
        *,
        candidate: str,
        context: str,
    ) -> dict[str, Any]:
        """Score ``candidate`` against ``context`` for groundedness.

        Returns ``data: {"overlap_ratio": 0..1, "is_refusal": bool, "verdict": ...}``.
        """
        if not isinstance(candidate, str) or not candidate:
            return _ok_envelope(
                self.name,
                {"overlap_ratio": 0.0, "is_refusal": False, "verdict": "allow"},
            )

        # Refusal detection
        cand_low = candidate.lower()
        is_refusal = any(p in cand_low for p in REFUSAL_PHRASES)
        if is_refusal:
            return _ok_envelope(
                self.name,
                {
                    "overlap_ratio": 0.0,
                    "is_refusal": True,
                    "verdict": "allow",
                    "reason": "model_refused",
                },
            )

        # N-gram overlap (trigrams)
        overlap = _trigram_overlap(candidate, context or "")

        # Default action is ``block`` for hallucination.
        action = "block"
        try:
            policies = await _fetch_policies(org_id, status="active")
        except Exception:  # pragma: no cover - defensive
            policies = []
        for p in policies:
            if p.get("type") == "hallucination":
                p_action = p.get("action")
                if p_action in VALID_ACTIONS:
                    action = p_action
                break

        # Below 0.2 overlap is "ungrounded" — block (or the
        # policy's action). Between 0.2 and 0.4 is "weakly
        # grounded" — the signal is too noisy on its own to
        # justify the org's full configured severity, so it's
        # capped at ``warn``: an action *more* severe than warn
        # (redact/escalate/block) is downgraded to warn, but an
        # action *no more* severe than warn (allow/warn itself)
        # is honored as-is, so an org that has deliberately
        # configured leniency (``action='allow'``) for this
        # policy isn't overridden into an unwanted warn. Above
        # 0.4 is "grounded" — allow.
        if overlap < 0.2:
            verdict = action
        elif overlap < 0.4:
            verdict = action if ACTION_RANK.get(action, 0) <= ACTION_RANK.get("warn", 1) else "warn"
        else:
            verdict = "allow"

        return _ok_envelope(
            self.name,
            {
                "overlap_ratio": round(overlap, 4),
                "is_refusal": False,
                "verdict": verdict,
            },
        )


def _trigram_overlap(candidate: str, context: str) -> float:
    """Return the trigram-overlap ratio of ``candidate`` vs ``context``.

    A trigram is considered "present" if it appears at least
    once in the context. The ratio is
    ``present_trigrams / candidate_trigrams`` (0 if either
    side is empty or shorter than 3 chars).
    """
    c = (candidate or "").lower()
    x = (context or "").lower()
    if len(c) < 3 or len(x) < 3:
        return 0.0
    cand_tris: set[str] = set()
    ctx_tris: set[str] = set()
    for i in range(len(c) - 2):
        cand_tris.add(c[i:i + 3])
    for i in range(len(x) - 2):
        ctx_tris.add(x[i:i + 3])
    if not cand_tris:
        return 0.0
    present = sum(1 for t in cand_tris if t in ctx_tris)
    return present / len(cand_tris)


# ─── LLMFirewall ─────────────────────────────────────────────────


class LLMFirewall:
    """Lunary-style pre-LLM-call firewall.

    Runs the prompt through the injection detector + the PII
    firewall *before* the prompt is sent to the provider. If
    either fires, the firewall returns a non-allow verdict so
    the caller can block the call. PII is *redacted in place*
    (the prompt the provider sees has ``[REDACTED:SSN]`` etc.)
    — the customer controls whether the redacted or the
    original prompt is returned to the caller.
    """

    name = "llm_firewall"

    async def firewall(
        self,
        org_id: str,
        *,
        prompt: str,
    ) -> dict[str, Any]:
        """Run the pre-LLM firewall on ``prompt``.

        Returns ``data: {"verdict": "allow|redact|block",
        "redacted_prompt": "...", "injection": {...}, "pii": {...}}``.
        ``verdict='allow'`` means the prompt is safe to send
        to the provider. ``verdict='redact'`` means the prompt
        is safe *with redaction* (the caller must use
        ``redacted_prompt``). ``verdict='block'`` means the
        prompt is unsafe — do not send.
        """
        if not isinstance(prompt, str) or not prompt:
            return _ok_envelope(
                self.name,
                {
                    "verdict": "allow",
                    "redacted_prompt": prompt or "",
                    "injection": {"verdict": "allow", "matches": []},
                    "pii": {"redacted": prompt or "", "matches": []},
                },
            )

        injection = await PromptInjectionDetector().scan(org_id, text=prompt)
        pii = await PIIFirewall().redact(org_id, text=prompt)
        inj_data = (injection.get("data") or {})
        pii_data = (pii.get("data") or {})

        inj_verdict = inj_data.get("verdict", "allow")
        pii_redacted = pii_data.get("redacted", prompt)
        pii_matches = pii_data.get("matches", []) or []

        if inj_verdict in ("block", "escalate"):
            verdict = "block"
        elif pii_matches:
            verdict = "redact"
        else:
            verdict = "allow"

        return _ok_envelope(
            self.name,
            {
                "verdict": verdict,
                "redacted_prompt": pii_redacted,
                "injection": inj_data,
                "pii": pii_data,
            },
        )
