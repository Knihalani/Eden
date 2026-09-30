---
description: Implement one Eden memory-program slice end to end (pre-register → red tests → implement → verify → independent review → merge → report).
argument-hint: "<slice id, e.g. P0.-1 or P2.3>"
---

Implement memory-program slice **$ARGUMENTS** completely and to a very high standard, then merge it and report.

You have full permissions: commit, push, open PRs and merge into `main` yourself. That makes you responsible for quality. Follow `CLAUDE.md` exactly: the slice lifecycle, the engineering rules and the report format. Do not skip or compress a step.

## 0. Orient (read before writing anything)

1. `docs/memory-ship/PROGRESS.md`: confirm $ARGUMENTS exists, is `todo` (or `in-progress` from an earlier run you are resuming), and that every dependency is `done`. If a dependency is not done, stop and report which one.
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
- Mark the slice `in-progress` in PROGRESS.md with the branch name. This is the first commit, together with the prereg.

## 2–5. Pre-register, red first, implement, verify

Follow `CLAUDE.md` steps 2–5 exactly. Additional requirements:
- **Baselines are measured.** Run the metric on `origin/main` before changing anything.
- **Scope before the harness exists.** For slices before P0.0c, the gate is the one in PROGRESS.md's Gate column plus CI. Write tests for the behaviour you change anyway.
- **Quality bar.** Code a strong reviewer would call clean:
  - small, well-named functions;
  - types that match the spec vocabulary;
  - no dead code;
  - no duplicated helpers;
  - comments only where intent is not obvious.
- **When the spec is wrong or impossible** (contradicts measured reality or the hook docs in `docs/memory-ship/research/sources/`): do not silently deviate. Implement the closest faithful version, record it under "Decisions made", and add a follow-up to update DECISIONS / A4 in the same PR if the change is clear-cut.
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

- Launch the `slice-reviewer` subagent with the slice id, the worktree path and the base ref `origin/main`.
- Give it your draft report so it can check the numbers.
- Address every blocker and major finding, then re-run the reviewer. Minor findings: fix them, or list them under follow-ups.
- Maximum 3 rounds. If it still requests changes after that, mark the slice `blocked` with the unresolved findings. Do not merge.
- Also run `/security-review` where `CLAUDE.md` requires it.

## 7. Merge

1. Rebase on `origin/main` and re-run CI's four steps locally.
2. Push, and open the PR titled `<slice id>: <title>`, with the report as its body.
3. `gh pr checks --watch`.
   - CI must be green.
   - Exception: until P0.−1 is merged, `main` is red, so require "no new failures versus `main`" and show the comparison.
4. `gh pr merge --rebase --delete-branch`.
5. Record the merge commit sha.
6. Remove the worktree.

## 8. Report

- Write `docs/memory-ship/reports/<slice>.md` in the `CLAUDE.md` format.
- Update the PROGRESS.md row: `done`, PR number, report link.
- Commit both through a follow-up PR (`<slice id>: report`), merged the same way, or include them in the slice PR before merging (preferred).
- Your **final message is the report**, complete and formatted. Every number must come from output you produced in this session.

If anything forces you to stop early (a blocker, missing access, a failing dependency), still write the report with `**Outcome:** blocked` and exactly what is needed to unblock.
