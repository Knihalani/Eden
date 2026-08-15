# Guardrail prioritization decision (FEAT-126)

**Status:** ✅ DONE — 2026-08-07

## Decision

New guardrail **feature** work — new detector categories, new policy types,
portal expansions, eval-to-guardrail flows, and similar — must be **sequenced
after** the foundation fixes documented in `12-runtime-guardrails.md` and
related WAVE-PLAN guardrail items (e.g. FEAT-125 enum alignment, trace-quality
bypass remediation, eval-promotion wiring).

This is an **engineering prioritization guardrail**, not a product deprecation.
The existing `InterventionEngine` and detector stack remain in scope; the rule
is that foundation debt is paid down before layering new capability on top.

## Why

`12-runtime-guardrails.md` frames this area as potentially the single
highest-priority finding of the three-pass strategic review: a default-on code
path can silently bypass content-safety checks, and eval-promotion semantics
are split across incompatible implementations. Building new guardrail features
in parallel compounds safety risk and rework.

## What this blocks (until foundation items land)

- New detector categories or ML-backed classifiers added without fixing the
  `trace_id` hot-path bypass and observability gaps.
- New policy types or portal surfaces that assume the current enum / enforcement
  contract is stable.
- Marketing or roadmap claims that expand guardrail coverage before the doc's
  P0 fixes ship.

## What this does not block

- Bug fixes and hardening items explicitly listed in `12-runtime-guardrails.md`
  and WAVE-PLAN guardrail rows — those **take priority** over new features.

## Process

Roadmap and sprint planning should treat `12-runtime-guardrails.md` foundation
items as a **prerequisite gate** for new guardrail feature epics. FEAT-126 is
the explicit Wave 5 record of that gate; it does not implement the fixes
themselves.
