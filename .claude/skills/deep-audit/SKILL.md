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
8. **Report**: a plain-language summary goes at the top of the audit file and comes back to you.

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
   Say the expected scale in one line before starting. A round runs about 9 finders, up to 2 verifiers per
   finding, 2 agents per package attempt, and a cleanup step that frees finished worktrees.
4. **While it runs**, stay available. If the user interjects, answer; don't stop the run unless they ask.
5. **After it returns:**
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
6. **Report to the user** using the template below. Keep it short and legible: plain words, one idea per line,
   numbers with what they mean.

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

**Biggest fixes** (measured before → after; estimates labelled):
- …

**Still open, and what's needed:**
- <item>: <why open: needs your decision / too big / rejected by review> → <next step>

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
