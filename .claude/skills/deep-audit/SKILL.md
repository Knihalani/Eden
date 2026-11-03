---
name: deep-audit
description: Full audit-and-fix run. Hunts ambitiously for 1.5x-and-bigger improvements (configurable) in cost, latency, quality, scale and the dev loop (plus first-principles redesigns), inefficiencies, correctness bugs and user pain points (security is out of scope; use /security-review for that); verifies each finding adversarially; writes an audit; dispatches subagents to fix everything on branches; reviews their work and loops until nothing material is left; then reports in plain language. Use when the user asks for a deep audit, an overhaul, "find and fix everything", or order-of-magnitude improvements across the repo.
---

# Deep audit: find, verify, fix, review, repeat, report

This skill runs the saved `deep-audit` workflow (`.claude/workflows/deep-audit.js`) and wraps it with the steps a
workflow cannot do on its own: preflight, measuring the baseline, opening PRs, and the final explanation to the user.
Running this skill is the user's opt-in to multi-agent orchestration: call the Workflow tool as step 3 says.

## What it does

1. **Map**: one agent reads the repo's CLAUDE.md files and docs, runs the checks, and writes an orientation brief:
   areas, hot paths, how to measure, rules that constrain changes.
2. **Find**: nine finders in parallel. Six are ambitious levers, each told to brainstorm at least 12 ideas (including
   unconventional ones), measure the baseline, and keep only what the arithmetic says reaches **at least 1.5x** (`minMultiple`, default 1.5)
   (10x or more ranks highest):
   - **cost**: model/API calls and tokens, connector calls, storage, compute per task and per user;
   - **latency**: what the user or integrating agent waits for, p50 and p90;
   - **quality**: the product's own success metrics (miss rate, false alarms);
   - **scale**: memory and CPU per user and item, throughput, ingest, accounts 10-100x larger;
   - **devloop**: check, test, benchmark and experiment time and cost;
   - **moonshot**: first-principles redesigns from the repo's research, each with a first experiment.

   Three more cover the rest:
   - **inefficiency**: wasted work, uncacheable prompts, redundant calls, dead flags, slow tests;
   - **painpoint**: integrator, end-user and developer journeys, walked through for real;
   - **correctness**: bugs, with a failing test or a command.

   Security is not audited here (use `/security-review`), but no fix may weaken a security, privacy or isolation
   check.
3. **Dedup and verify**: duplicates are merged. Two skeptics check each finding: one re-runs the evidence, the other
   checks the impact arithmetic and the fix. Only findings that hold up are kept.
4. **Audit**: a report is written (`docs/audits/<date>-deep-audit.md`) and split into work packages that share no files.
5. **Fix and review**: one fixer per package, in its own worktree and branch, tests first, measuring before and after.
   An independent reviewer re-runs everything and approves or sends it back; up to three attempts per package.
6. **Integrate**: approved branches are merged into `audit/<date>-integration`, and the full checks run there.
7. **Repeat**: the finders run again on what changed and on anything still open, until a round finds nothing material
   (no verified finding above "low") or the round limit is reached.
8. **Finalize, no loose ends**: every flag or option the run added is measured on against off. It is then made the
   default (with a decision row), removed with its dead code, or kept off only with a recorded reason and a next
   step. Every deferred or unresolved item is resolved or decided in writing. Approved branches left unmerged, new
   TODO/FIXME lines and docs that disagree with the code are fixed. Production defaults are checked against the best
   measured preset and promoted where possible, or the blocker is recorded with its fix. These fixes get the same fix → review → merge
   loop, for up to two passes.
9. **Report**: a plain-language summary goes at the top of the audit file and comes back to you.

## How to run it

1. **Ask only what you must.** Use the user's message for scope and focus. Ask, in one question, only if it is
   unclear whether paid model/API calls are allowed, and with what budget. The default is no paid calls.
2. **Preflight (inline, quick):**
   - `git status` is clean. Note the current branch and today's date (`date -u +%F`).
   - Fetch and start from the default branch: `git fetch origin && git checkout <default> && git pull`.
   - Run the repo's check command once and note its time and result. A red baseline goes in the report, not under it.
   - Check free disk. Every fixer, reviewer and integrator gets its own worktree, a full checkout of the repo. Free at
     least (checkout size) × (maxPackages × fixAttempts × 2 + 10) before starting (`df -h .`, `du -sh` of a fresh
     checkout), and remove stale worktrees first (`git worktree list`; remove only ones whose branches are pushed or
     merged). A full disk stops the run mid-way.
   - If another session or agent is editing parts of the repo, list those paths in `focus` as "do not edit: …".
3. **Run the workflow** with the Workflow tool, `name: "deep-audit"`, and `args` as a JSON object:
   ```json
   {
     "scope": "the whole repository",
     "focus": "<the user's emphasis, if any; plus 'do not edit: …' paths>",
     "date": "<YYYY-MM-DD>",
     "minMultiple": 1.5,
     "maxRounds": 3,
     "maxFindings": 24,
     "maxPackages": 10,
     "fixAttempts": 3,
     "allowSpend": false,
     "spendNote": "<budget and metering, only if the user allowed paid calls>",
     "reviewerAgent": "<a custom reviewer subagent if the repo has one, e.g. reviewer>",
     "baseBranch": "<default branch>"
   }
   ```
   Scale down for a small repo or a quick pass (`maxRounds: 1`, `maxFindings: 10`). Scale up only if the user asked
   for exhaustive. Each round runs up to about 5 finders, 2 verifiers per finding, and 2 agents per package attempt.
   Speed: a workflow runs at most (CPU cores − 2) agents at once, so a 4-core container runs 2. Expect hours for
   a full run there. The run already avoids waste: it verifies only the findings it will fix this round, gives fixers
   the reviewer's checklist up front (fewer reject-and-redo cycles), and uses fast checks while iterating with one
   full check at the end.
   Say the expected scale in one line before starting. A round runs about 9 finders, up to 2 verifiers per
   finding, 2 agents per package attempt, and a cleanup step that frees finished worktrees.
4. **While it runs**, stay available. If the user interjects, answer; don't stop the run unless they ask.
   - **Updates at every milestone, and only then.** The milestones are:
     - a round's findings verified;
     - a round's audit and packages written;
     - a round's fixes merged, or a merge failing;
     - Finalize starting;
     - the run finishing or failing.

     Watch for them with a background script that tails the run's `journal.jsonl` (the transcript directory the
     Workflow tool printed). It exits when a new `audit:`, `integrate:`, `finalize-plan:` or `report` agent starts, or
     a new `find:rN` round begins. Restart it after each update, and report a stop at the time limit.
   - **Every update uses the update template below.** Pull the numbers from the journal's results: packages, fixers'
     `measured` fields, reviewers' verdicts, the integrator's checks. Include all the relevant data, formatted.
5. **Decisions are yours, not the user's.** The user delegates judgement calls. Decide from the measurements, record
   each in the repo's decision log with its evidence, and report what you decided. Ask the user only about paid spend
   beyond the agreed budget, an irreversible or external action, or something only they can do, such as a key or
   access.
6. **After it returns:**
   - Check every package branch against the integration branch (`git merge-base --is-ancestor <branch>
     audit/<date>-integration`): a fix that was approved but not merged, or published to a stray worktree branch,
     has to be merged now. Treat the workflow's ledger as a claim and git as the truth.
   - Check out the integration branch and run the checks yourself. Do not trust the workflow's "green".
   - If the repo requires a reviewer agent for the kind of change made (its CLAUDE.md says so), run it once on the
     whole combined diff and fix what it finds before shipping.
   - Read the audit file's summary and spot-check two or three fixes against their findings.
   - Ship it the way the repo's CLAUDE.md says: usually one PR from the integration branch, or one PR per independent
     area if the repo prefers small PRs. Merge only if the repo allows agents to merge and every required check
     and review has passed.
   - Clean up: once the branches are merged and pushed, remove the run's worktrees (`git worktree list`, then
     `git worktree remove` on each one under the workflow's worktree folder) and `git worktree prune`.
7. **Report to the user** using the template below. Keep it short and legible: plain words, one idea per line,
   numbers with what they mean.

## Scale out across cloud sessions (when the container is small)

A workflow runs at most (CPU cores − 2) agents at once, so a 4-core container fixes packages two at a time. If you can
create cloud sessions (each runs on its own machine), use them for the fix stage:
1. Run the workflow with `"planOnly": true`. It maps, finds, verifies and writes the audit, then returns the packages
   (with `map`, `findings` and `deferred`) without fixing them.
2. Push the integration branch it created. Then, for each package, or group of packages that share no files, start
   one cloud session from that branch with a self-contained brief:
   - the package, its findings and acceptance checks;
   - the orientation brief, the repo rules and the reviewer's checklist;
   - the files other sessions are changing, so it avoids them;
   - "tests first, measure before and after, run the repo's reviewer, push a branch, open a PR, do not merge, then
     message the parent with the results".
3. When they report, merge their branches into the integration branch yourself, resolve conflicts, and run the checks
   and the combined-diff review. Then re-run the workflow with `"finalizeOnly": true` and `"deferred": [...]` to close
   loose ends, and repeat from step 1 for a new round if material findings remain.

Parallel sessions spend the same tokens sooner. Mention it if the account shows a usage warning.

## Update template (every milestone)

```
**<Milestone>: <one-line outcome>** (e.g. "Round 2 fixes merged: 7 of 8 approved, all checks green")

1. Outcome: what finished; succeeded / partly / failed.
2. Numbers: found / confirmed / rejected / packages / approved / sent back / still open (a table).
3. What changed: one line per fix: what it does, measured before → after with units, why it matters.
4. Problems: anything rejected, blocked or broken, and what happens next.
5. Decisions made: one line each, with the evidence.
6. Health: tests passing / total, eval unchanged or changed, disk free, spend.
7. Next: the next step and how far through the run it is.
```

## Report template

```
**Bottom line:** <3–5 sentences: what was wrong, what is now fixed, what changes for users, cost, speed and safety>

| Area | Found | Confirmed | Fixed + reviewed | Still open |
|---|---|---|---|---|
| Cost (≥1.5×) | … | … | … | … |
| Latency (≥1.5×) | … | … | … | … |
| Quality (≥1.5×) | … | … | … | … |
| Scale (≥1.5×) | … | … | … | … |
| Dev loop (≥1.5×) | … | … | … | … |
| Moonshots | … | … | … | … |
| Inefficiencies | … | … | … | … |
| User pain points | … | … | … | … |
| Bugs | … | … | … | … |

**What was achieved** (one row per merged fix; estimates labelled):

| Fix | Before → after (units) | Shipped as |
|---|---|---|
| … | … | default / flag with recorded reason / removed |

**Decisions I made:**
- <decision>: <evidence> → <decision-log row>

**Still open, and what's needed:**
- <item>: <why open: needs paid spend beyond budget / external action / rejected by review> → <next step>

**Where it is:** audit <path> · branch <integration branch> · PR <link>
```

## Rules that always apply

- The repo's CLAUDE.md files and decision log win over this skill.
- Every number comes from a command that was run; anything else is labelled an estimate with its arithmetic.
- Never weaken a security, privacy or isolation check, and never skip or delete a test, to make something pass.
- No paid model or API calls unless the user allowed them, metered against the budget they gave.
- Never print secrets. Never force-push a shared branch. Never merge red.
- An order of magnitude is often impossible for a whole system. Say so plainly, then name the part where it is
  possible.
