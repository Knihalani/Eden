# Deleted Feature Specs — Rationale & Merge Map

> **Updated:** July 15, 2026 (bloat-cut pass)  
> **Inventory:** 24 F-features + **14 N-features** (N23 added; Cat 23 retired)

---

## July 2026 bloat cut

### Cat 23 — Autonomous code modification (full removal)

| Removed | Reason | Replacement |
|---|---|---|
| `src/eden/code_change/` (~62 files) | Stub-heavy package; dual inbox with JSONL suggester; cluster scheduler disconnected from F29 issues | [N23](n23-recurring-improvement-agent.md) recurring improvement agent (spec) |
| `src/eden/api/routes/intelligence_code_change.py` (46 routes) | No portal consumers; `not_implemented` envelopes | `GET/POST /orgs/{id}/improve/plans` (N23) |
| Cat 23 cron (`code_change/scheduler.py`) | Overlapped N20 weekly optimization without issue context | Per-org `improvement_schedule_cron` (N23) |

**Salvaged modules** (moved to `src/eden/improvement/`):

- `issue_patch_trigger.py` — issue → plan enqueue
- `patch_generator.py` — unified diff generation
- `pr_creator.py` — GitHub PR via `PRProvider`
- `issue_fix_chat.py` — chat-guided fix (F22)

**Legacy DB tables preserved (read-only):** `proposed_patches`, `pr_rejection_memory`. New writes target `improvement_plans` (N23).

### Portal routes — nav-hidden or redirected (moderate cut)

| Route | Action | Redirect / notes |
|---|---|---|
| `/observability/apm` | Nav removed | Static OTel install stub; redirect to `/observability` or docs |
| `/users` (User Intelligence) | Nav removed | Power-user only; route may 301 to `/fleet` |
| `/observability/cohorts` (Columnar Engine) | Nav removed | SQL console; deep links preserved |
| `/synthetic` (Synthetic Q/A) | Nav removed | Overlaps datasets eval authoring |
| `/redteam` | Nav removed | Thin adversarial page |
| `/billing` | Merged | Redirect to Settings → Billing tab |
| `/closed-loop` | Nav hidden | Redirect to `/improve` (N17 cockpit) |
| `/autonomous` | Nav hidden | Redirect to `/improve` |
| `/pr-suggestions` | Superseded | Redirect to `/improve/plans` (N23) |
| `/onboarding/autonomous` | Deleted | Legacy redirect removed |

Orphan components removed: `TraceTreeTab.tsx`, `TimelineTab.tsx`, `HeatmapTab.tsx` (never imported).

### P2 competitor-parity specs — archived

Moved to [`../archive/`](../archive/) (not on execution roadmap):

| ID | Feature |
|---|---|
| F59 | Custom render templates |
| F63 | Judge autotune / CLHF |
| F67 | LLM jury / composite metrics |
| F69 | Remote eval sandboxes |
| F72 | Virtual / customer data planes |
| F77 | Fine-tune export pipeline |
| F78 | Multimodal playground inputs |
| F80 | OSS local workshop |

---

## Restored as N-features (high value returned)

| Deleted | Restored as | Why restored |
|---|---|---|
| F11 Trace deduplication | **N09** | Enterprise storage cost + query speed |
| F36 Deep search → classifier | **N10** | Raindrop conversion UX |
| F10 Local dev server | **N11** Live streaming | Real-time debug without OSS Workshop |
| F17 Session timeline UI | **N12** | Sentrial session-first parity |
| F38 Transcript UI v2 | **N13** | Demo-quality portal UX |

| Deleted | Absorbed into |
|---|---|
| F27 Use-with-AI docs | F04 §17 |
| F02, F05, F07, F08, F26, F37, F45 | F01, F04, F06, F39 |

## Still deleted (low incremental value)

F13–F16, F18, F19, F24, F25, F31, F32, F43 — see prior rationale. Framework integrations → OTel + F09 examples.

---

## Full inventory

### F-features (24 active + 8 archived)
F01, F03, F04, F06, F09, F12, F20, F21, F22, F23, F28, F29, F30, F33, F34, F35, F39, F40, F41, F42, F44, F46, F47, F48 (+ F49–F85 eval/portal band; F59/F63/F67/F69/F72/F77/F78/F80 archived)

### N-features (14)
N01–N13, N14–N23 (N20 inbox superseded by N23; Cat 23 retired)

---

## Performance requirement

All surviving and restored specs include **§ Performance & cost optimization** per [PERFORMANCE-COST-STANDARDS.md](../PERFORMANCE-COST-STANDARDS.md).

---

*Git history for deleted files: `git show 5b3da62:docs/specs/features/fXX-*.md`*
