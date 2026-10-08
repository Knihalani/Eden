---
description: Pick the next unblocked memory-program slice from PROGRESS.md and implement it end to end (same lifecycle as /slice), then report.
argument-hint: "[optional: 'stages' to only check rollout stages]"
---

Advance the Eden memory program by one unit of work, completely and to a very high standard.

1. `git fetch origin` and read `docs/memory-ship/PROGRESS.md` on `origin/main`.
2. **If the argument is `stages`, or no slice is eligible:**
   - Evaluate the rollout stages. A stage is eligible when:
     - its deps are `done`;
     - its entry criteria are met, measured from shadow logs and reports;
     - its minimum soak time has passed since the previous stage.
   - Labels that need a human must exist in `docs/memory-ship/labels/<stage>.md` and be filled in. If they are not, prepare that file (packets to label, ids only plus the rendered bullet text) and report the stage as `waiting`.
   - If a stage is eligible, flip its flag in `~/.eden/flags.json`, then write `reports/stage-<n>.md` with the evidence.
3. **Otherwise pick** the first row in the Slices table that is `todo` (or `in-progress` with no open PR activity for over 24 h) and whose deps are all `done`. The table order is the priority.
4. Run the full `/slice` procedure (`.claude/commands/slice.md`) for that id, with no shortcuts, and fast, as below.
5. End with the slice report as your final message, then one line: `Next eligible: <id>` (or what is blocking progress).

## Speed (every slice)

Quality gates stay as they are. The time goes to running each slow thing once, in parallel where it is safe, and only when a change can affect it (`.claude/commands/slice.md` §5–6):
- **Iterate cheaply:**
  - the affected test files;
  - the slice's arms;
  - committed probes from earlier review rounds;
  - for a behaviour change, one kept world replay and the real-session end-to-end.

  No full measurement while the code is still changing.
- **Code review before measuring.** Run `slice-reviewer` on the code (phase `code review`) first.
- **Measure once,** on the approved commit: `bun run measure:slice --new <checkout> --base <base checkout> --out <dir> …`. It runs the arms, guard runs and R6 replays in parallel, and the soak and bench alone on a quiet machine. Then continue the same reviewer for the evidence check, from the artifacts.
- **Re-measure only what a change can affect:** `--changed <last measured commit>`. Report what it skipped and why.
- **Reuse what is already measured:** one base checkout and one set of base guard runs per slice (`--guard-base`).
- **Local CI once,** on the final tree: `bun run test:parallel` for the suite, and the other three CI steps.
- **One heavy job at a time,** on a quiet machine. Report the load next to timing numbers.
- **Batch pushes.** Each push runs seven CI jobs.

If nothing is eligible and no stage can move, say so plainly and list what each blocked item is waiting on: dependencies, soak time, user labels, or user actions such as R-1.
