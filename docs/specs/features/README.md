# Feature Implementation Specs

> **Master document:** [`../FEATURE-GAP-MASTER.md`](../FEATURE-GAP-MASTER.md) — complete inventory of everything Eden is missing  
> **Review:** [`SPEC-REVIEW.md`](./SPEC-REVIEW.md)

## 48 feature specs (canonical)

Each file `fXX-{slug}.md` is a **standalone implementation spec** for one feature. Specs are organized by feature, not by competitor.

| Priority | Features |
|---|---|
| **P0 — Ship first** | F01, F03, F04, F20, F28, F29, F30, F39, F46, F47, F48 |
| **P1 — Next** | F02, F05, F06, F09, F10, F13–F15, F22, F23, F31–F35, F40–F44 |
| **P2 — Polish** | F07, F08, F11, F16–F19, F21, F24–F27, F36–F38, F45 |
| **P3 — GTM/docs** | F27, F19 |

## Quick start for engineers

1. Read [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md) Section 3 for the full missing-feature list
2. Pick a feature ID from Wave 0/1 in the master doc
3. Open `fXX-*.md` and implement against acceptance criteria
4. Check dependencies in Section 12 of each spec before starting

## Generator

`generate_specs.py` regenerates skeleton specs from embedded definitions. **Hand-edited specs (F01, F20, F29, F39, F48) take precedence** over regeneration.
