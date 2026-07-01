# prompts/ — the goal prompt + 10 supplemental instruction files

This directory contains the compact goal prompt (3,983 chars) plus the
10 supplemental instruction files referenced inside it. A new agent
invoked with the goal should:

1. Read the goal message (3,983 chars; under the 4000 limit).
2. Read `eden-trace-quality-system-spec.md` (1866 lines, v2.6).
3. Read every file in this directory in numeric order before
   writing any code.

## Files

| File | Purpose | ~Chars |
|---|---|---:|
| The goal message body | Compact `<4000 char` prompt with `prompts/NN_*.md` references | 3983 |
| `01_constraints.md` | 12 hard constraints — full detail | 3,300 |
| `02_no_drop_invariant.md` | The 16-item acceptance contract | 2,300 |
| `03_stop_conditions.md` | 7 binary TRUE/FALSE stop conditions | 1,950 |
| `04_non_completion.md` | 14 anti-patterns | 1,740 |
| `05_deliverables.md` | Full A→H per-deliverable spec | 5,900 |
| `06_settings.md` | Settings fields + env-var mapping | 2,200 |
| `07_tests.md` | Test depth targets | 2,750 |
| `08_spec_propagation.md` | Spec commit rules + handoff template | 3,200 |
| `09_enhancement_charter.md` | 8 enhancements + Pareto decision rule | 6,150 |
| `10_iteration.md` | Per-step discipline + ordering | 3,300 |

## Why this structure

The compact goal message stays under the 4000-char prompt budget.
Every section that would otherwise bloat the prompt is moved into a
named file so the agent can deep-dive on demand. The numbers on
each section let the implementing agent bound their search when a
problem occurs.
