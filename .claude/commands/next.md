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
4. Run the full `/slice` procedure (`.claude/commands/slice.md`) for that id, with no shortcuts.
5. End with the slice report as your final message, then one line: `Next eligible: <id>` (or what is blocking progress).

If nothing is eligible and no stage can move, say so plainly and list what each blocked item is waiting on: dependencies, soak time, user labels, or user actions such as R-1.
