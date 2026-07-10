# Deleted Feature Specs — Rationale & Merge Map

> **Updated:** July 9, 2026 (second pass)  
> **Inventory:** 24 F-features + **13 N-features** (5 restored as N09–N13)

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

### F-features (24)
F01, F03, F04, F06, F09, F12, F20, F21, F22, F23, F28, F29, F30, F33, F34, F35, F39, F40, F41, F42, F44, F46, F47, F48

### N-features (13)
N01–N13

---

## Performance requirement

All surviving and restored specs include **§ Performance & cost optimization** per [PERFORMANCE-COST-STANDARDS.md](../PERFORMANCE-COST-STANDARDS.md).

---

*Git history for deleted files: `git show 5b3da62:docs/specs/features/fXX-*.md`*
