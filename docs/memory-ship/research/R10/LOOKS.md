# R10 — every look at a test or holdout set

Append-only. One line per scoring run on a test split or a holdout (BRIEF §4.9).

- 2026-10-18 (cycle 3): no look so far. Every StreamBench number in LEDGER C1–C2 is on `--split dev`. No StreamBench test split has been scored, and no holdout has been written. STATE cited this file before it existed (critic C2); it now exists.
- 2026-10-19 (cycle 4, C4-E4): red-team round 1, `--split fresh` on `code-rt1` and `life-rt1`. These are fresh cases, not test or holdout, but they count as looks: the methods scored there (eden, lex `tau=4,when=1,gate=1`, bank, vote, oracle-need) were not tuned on them afterwards. The same session re-ran the lex row once to answer critic C4 (C4-E6). StreamBench test split: still never scored. Holdout: still not written.
