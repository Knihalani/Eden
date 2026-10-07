---
description: Implement one Eden memory-program slice end to end (pre-register → red tests → implement → verify → independent review → merge → report).
argument-hint: "<slice id, e.g. P0.-1 or P2.3>"
---

Implement memory-program slice **$ARGUMENTS** completely and to a very high standard, then merge it and report.

You have full permissions: commit, push, open PRs and merge into `main` yourself. That makes you responsible for quality. Follow `CLAUDE.md` exactly: the slice lifecycle, the engineering rules and the report format. Do not skip or compress a step.

## 0. Orient (read before writing anything)

1. `docs/memory-ship/PROGRESS.md`: confirm $ARGUMENTS exists, is `todo` (or `in-progress` from an earlier run you are resuming), and that every dependency is `done`. If a dependency is not done, stop and report which one. Read its follow-ups table too: the rows for $ARGUMENTS are part of the slice.
2. Read, in full:
   - the slice's ROADMAP row;
   - every DECISIONS row it cites (D/X numbers);
   - the A4 / A7 / A6 sections it implements;
   - its A5 arms and metrics;
   - EXECUTION §3 (definition of done).
   Then read the research report behind each decision you implement, when the spec is terse.
3. Read the code you will change, and its tests, before planning. Use `git log -p` on files with unclear history.
4. Write a short plan: files, functions, tests, risks, and how you will verify end to end. Keep it in your notes; it goes into the report.

## 1. Isolate

- `git fetch origin`.
- Create a worktree on `mem/<slice>-<short-slug>` from `origin/main` (EnterWorktree, or `git worktree add .claude/worktrees/<slice> -b <branch> origin/main`).
- Run `bun install --frozen-lockfile` in it. Without it the plugin cannot import `@eden/ir`, and every hook falls back to spawning `eden hook` (about 2.6 s each), which skews timings and end-to-end runs.
- A worktree nested in the repo (`.claude/worktrees/…`) gets 2 false typecheck errors (Buffer types in `apps/site/src/assets.ts` and `packages/know/src/cdx.ts`). Run the final local CI in a checkout outside the repo, such as a detached `git worktree add` under your scratchpad, after `bun install --frozen-lockfile` there.
- Make the baseline checkout once, and reuse it for the whole slice: `git worktree add --detach <scratchpad>/base origin/main`, then `bun install --frozen-lockfile` there. The measure script's `--base` and the soak and timing comparisons use it; measure the base guards once (`--guard-base` reuses their files afterwards).
- Mark the slice `in-progress` in PROGRESS.md with the branch name. This is the first commit, together with the prereg.

## 2–5. Pre-register, red first, implement, verify

Follow `CLAUDE.md` steps 2–5 exactly. Additional requirements:
- **Baselines are measured.** Run the metric on `origin/main` before changing anything: `bun run measure:slice --new <scratchpad>/base --out <scratchpad>/measure-base --only <the slice's measures>`. Keep its `guards-new-*.json` files: they are the slice's `--guard-base` from then on.
- **The gate.** It is PROGRESS.md's Gate column plus CI. Since P0.0c, a gate's A5 arms are in `arms.json` and run with `benchmarks/memory-long-horizon/arms/run.ts` (README: "The A5 §4 arms"). Write tests for the behaviour you change anyway.
- **Quality bar.** Code a strong reviewer would call clean:
  - small, well-named functions;
  - types that match the spec vocabulary;
  - no dead code;
  - no duplicated helpers;
  - comments only where intent is not obvious.
- **When the spec is wrong or impossible** (contradicts measured reality or the hook docs in `docs/memory-ship/research/sources/`): do not silently deviate. Implement the closest faithful version, record it under "Decisions made", and add a follow-up to update DECISIONS / A4 in the same PR if the change is clear-cut.
- **Spend machine time once.** A full measurement takes 1–2 hours serially. P0.2 re-ran it after every fix, on six versions; measure the approved code once instead:
  1. **While iterating**, run only:
     - the affected test files;
     - the slice's arms (`arms/run.ts --arm <id>`, `--flags on|off|shadow` as separate processes);
     - the earlier review rounds' probes, committed as tests;
     - for a behaviour change, one kept world replay (`benchmarks/memory-long-horizon/harness/replay.ts --world <seed> --out <dir>`, about 2 minutes) and the real-session end-to-end (a few minutes).

     These are fast and catch most defects.
  2. **Code review before measuring** (§6, rounds 1–3).
  3. **Measure once**, on the commit the code review approved, from a checkout outside the repo:
     ```bash
     git worktree add --detach <scratchpad>/m-<sha> <sha> && (cd <scratchpad>/m-<sha> && bun install --frozen-lockfile)
     bun run measure:slice --new <scratchpad>/m-<sha> --base <scratchpad>/base --out <scratchpad>/measure-<sha> \
       [--guard-base <base guard JSON files>] [--r6-projects <frozen copy>] [--worlds 1,2] [--only …]
     ```
     The script runs the count-only measures `--jobs` at a time (default half the cores), longest first:
     - the arms: `on` twice, `off`, `shadow`;
     - the guard seeds, one process each;
     - the R6 replays;
     - the kept world replays.

     Load reaches these counts only through hook timeouts, and the summary counts those. It then runs the soak and the locked bench alone, each after the load falls, and records the load. `--only timing` adds the interleaved Submit timing with an A/A pair (`scripts/submit-timing.ts`), for a slice that changes Submit latency. It writes `summary.md`, with the guard table pooled and paired by `scripts/slice-guards.ts`; copy numbers from it.
  4. **After a later change**, re-measure only what that change can affect: `--changed <last measured commit>` selects from the changed files (docs and tests: nothing; `arms.json`: the arms; code the hook may load or the harness: everything). Copy its "selected"/"skipped" lines into the report. You may skip a measure it selected only for a reason a counter shows (e.g. the R6 replay records no invalidation, so a change confined to validity cannot move it), stated in the report.
  5. **Local CI once**, on the final tree, in the outside checkout: `bun run format:check && bun run typecheck && bun run test:parallel && EDEN_SKIP_CHECKS=1 bash scripts/build-cli.sh`.
  6. **A quiet machine for timing.** Never run two measurements, or a measurement and the local suite, at once. Check `uptime` before timing work, and report the load next to every latency number.
  7. **Batch pushes.** Push when you need GitHub CI's evidence (before the evidence check and the merge), not after each fix: each push runs seven CI jobs.
- **End-to-end means a real Claude Code session**, not a unit test. Run it headless against the worktree's plugin, with an isolated store:
  ```bash
  export EDEN_MEMORY_DIR=$(mktemp -d)
  EDEN_ROOT=$PWD claude -p "<scenario prompt>" \
    --plugin-dir ./plugins/eden-memory \
    --session-id $(uuidgen | tr A-Z a-z) \
    --debug-file /tmp/e2e-<slice>.log
  ```
  - Use `--resume <session-id>` for multi-turn scenarios.
  - Then show:
    - the hook ran (lines from the debug log);
    - what was injected (the `hook_additional_context` attachment in the session transcript under `~/.claude/projects/…/<session-id>.jsonl`);
    - Eden's `hook.log` ids.
  - Put the excerpts in the report. Never use your own live `~/.eden` store for e2e runs.
  - If the slice has no user-visible behaviour (e.g. P0.−1), run one Submit and one PostToolUse through the plugin, and show it still exits 0 with valid output.

## 6. Independent review

Two phases, so the slow measurement runs once, on approved code:
1. **Code review** (counted rounds). Before the full measurement, launch the `slice-reviewer` subagent with:
   - the slice id, the worktree path and the base ref `origin/main`;
   - `phase: code review`;
   - the results you have: tests, arms, the kept world replay and the end-to-end.

   Address every blocker and major finding, then re-run the reviewer. Minor findings: fix them, or list them under follow-ups. Commit the reviewer's probes (it saves them under `<scratchpad>/review-probes/`) as regression tests, so the same class of defect cannot come back unseen.
2. **Measure once** on the approved commit (§5).
3. **Evidence check.** Continue the same reviewer with `SendMessage`: give it the measurement directory and the draft report, `phase: evidence check`. It re-derives the numbers from the artifacts instead of re-running long measures.
   - A numbers-only finding: fix the report; it is not a new round.
   - A finding that needs a code change: a new code-review round, and re-measure with `--changed`.
- At most 3 code-review rounds. If the reviewer still requests changes, ask the user whether to allow one more round; otherwise mark the slice `blocked` with the unresolved findings. Do not merge.
- The reviewer relies on GitHub CI's run for the full suite rather than re-running it.
- Also run `/security-review` where `CLAUDE.md` requires it.

## 7. Merge

1. Rebase on `origin/main`. Re-run CI's four steps locally only if the rebase changed files your change touches or imports; otherwise GitHub CI covers it.
2. Push, and open the PR titled `<slice id>: <title>`, with the report as its body.
3. `gh pr checks --watch`.
   - CI must be green.
   - Exception: until P0.−1 is merged, `main` is red, so require "no new failures versus `main`" and show the comparison.
4. `gh pr merge --rebase --delete-branch`.
5. Record the merge commit sha.
6. Remove the worktree, the scratch checkouts (`git worktree remove`), and any private copy (such as an R6 snapshot).

## 8. Report

- Write `docs/memory-ship/reports/<slice>.md` in the `CLAUDE.md` format.
- Update the PROGRESS.md row: `done`, PR number, report link. Delete the follow-up rows the slice closed, and add a row for each follow-up you file that a later slice owns.
- Commit both through a follow-up PR (`<slice id>: report`), merged the same way, or include them in the slice PR before merging (preferred).
- Your **final message is the report**, complete and formatted. Every number must come from output you produced in this session.

If anything forces you to stop early (a blocker, missing access, a failing dependency), still write the report with `**Outcome:** blocked` and exactly what is needed to unblock.
