# B19: the final benchmark — raw Hermes, Eden before the wave, Eden final

Status: 2026-11-11, branch `claude/b19-final-bench`. Decisions D1040–D1045 (of D1040–D1049). **Lab only: no engine
or server file changes.** Every paid call goes to Anthropic through the lab provider (D97); none goes to OpenRouter,
so every figure here is a lab-provider figure. Sections 1–2 were written and committed before the final run;
section 3 is filled in after it.

## In plain words (so far)

- **The harness can run an Eden arm at any commit.** `packages/sim/lab/b19/arm-tree.sh` builds a git worktree with
  the lab harness at one commit (the suites, worlds, prompts, grader and both harnesses) and Eden's product packages
  (engine, graph, llm, primitives, protocol, redact, sources, server, client) at another. Both harnesses host Eden
  in-process (`ContextPartner`, `createMcpServer`), so the arm runs exactly that commit's Eden. `run.sh` runs one arm
  with every other setting pinned; `go.sh` is the final run, from one command.
- **The arms are isolated and run identical tasks.** The before tree's product packages have no diff against
  `5026ba512` (`git diff --stat`, empty). `tasks-hash.ts` gives the same sha256 in both trees for every task list,
  every world and the agent's and grader's prompts (train seed 42, short and days; no task text printed).
- **Two harness fixes were needed.**
  - **hermes-ab never wired the push check.** Every Hermes run up to now left the default's `check` part inert. It
    now builds a `PushChecker` on the reader's model, as `buildPartner` does (D1042).
  - **pi-ab could not load against an older engine.** It imported P3's `hits` helper, which needs engine exports
    5026ba512 lacks. It now loads that helper only for the `hits` arm (D1041).
- **hermes-ab now has pi-ab's `--days` mode, with the D813 journal and `--resume` (D1044).** A day's requests share
  one Hermes transcript, which the runner holds and sends with each request, and one Eden session. The day ends with
  pi-ab's recap after the day's planted times move. Tested on train:
  - all three arms ran, and the transcript carries within a day (prompt tokens grow request by request and reset at
    the next day);
  - a killed run resumed from its journal: day 0 was reused at $0, the Eden arm was refused without
    `--resume-biased`, and the run completed with it.
- **The amended pre-registration (D1045):** Hermes short and Hermes days are the headline; Pi short and Pi days are
  the secondary readout.
- **The dry runs cost $2.89** in total (the ledger, `.local/b19/ledger.jsonl`), all on train, seeds 41–44. They
  covered 17 small runs of all three arms: Hermes short in three connector settings, Hermes days, Pi short, Pi days,
  a resume test and two rehearsals of `go.sh`.
- **The final run should cost about $7.5** (estimate, from the dry runs' cost a task). Its hard cap is $25.

## 1. How it works

**Arms.** Each arm runs as its own process, from its own tree, on the same tasks.

| arm      | Hermes condition | Pi condition | Eden's code                                       |
| -------- | ---------------- | ------------ | ------------------------------------------------- |
| `raw`    | `hermes`         | `tools`      | none (the agent with its `search_<source>` tools) |
| `before` | `hermes+eden`    | `both+ask`   | `main` @ `5026ba512` (2026-11-11 13:57, #243)     |
| `final`  | `hermes+eden`    | `both+ask`   | `main` at the end of the night (the parent names it) |

`hermes+eden` and `both+ask` are the shape integrators ship: the agent's own tools, Eden's packets, and its
`ask_context`.

**What differs between `before` and `final`.** Sixteen commits, #244–#259. The ones that change the shipped default
are #254 (the push check and indirect requests join the default, D820–D829) and #252 (deleted switches, D814–D817).
The dry runs show the push check's effect directly: the `final` arm makes `eden.check` calls and hands packets on
fewer neutral turns.

**Pinned across arms (`run.sh`).**

- **Models:** agent `claude-haiku-5-5` and grader `claude-sonnet-5-5`, so every answer is Sonnet-graded in-run.
  The card, intent, reader and push-check roles are `claude-haiku-5-5`, the measured model the servers default to.
- **Engine settings:** `--config default`, which is each tree's own `DEFAULT_CONFIG`.
- **Coverage:** shipped coverage (D878: `cards-shipped.jsonl.gz` replayed as cards and intent), the same file for
  every arm.
- **Connectors:** time scale 1, the market `direct` source profile and `--push payload`. Pi also gets
  `--tenant-prompt` (B18's and A29's shape).
- **Ledger:** one spend ledger with a hard cap.
- **Order:** the three arms of a step run side by side, so their wall times share one machine load.

**Why the before arm needs no OpenRouter.** Its model roles are wired by the harness (`labModel`, Anthropic direct),
not by the server's `modelRolesFromEnv`. The arm runs 5026ba512's engine with the same lab transport as the others.

**Metrics (`report.py`).** Per arm:

- hidden facts raised (Sonnet's grade);
- false concerns on control tasks (the planted look-alike) and on neutral tasks;
- neutral-turn packets: the share of neutral tasks handed any item, and items a neutral task;
- agent tokens a task;
- Eden's own spend per 1,000 tasks by ledger role (`eden.cards`, `eden.check`, `eden.reader`; background cards
  included);
- connector calls a task: the agent's searches, the calls Eden's decision traces count on the task's clock, and the
  backfill's reads spread over the arm's tasks;
- wall time a task, p50 and p90, with each stream's first task excluded (worker start-up).

Each pair (final − before, final − raw, before − raw) is paired task by task. Its 95% intervals come from 5,000
bootstrap draws:

- short runs are clustered by template: suite and template, so a template's tasks over all seeds and variants move
  together;
- days runs are clustered by user-day;
- the naive task-level interval is printed beside each.

**Reproduce a dry run** (train, $0.2–0.6 for three arms):

```bash
export HARNESS=$(git rev-parse HEAD) FINAL=$(git rev-parse HEAD) HC=3
M="--source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload"
for a in raw before final; do bash packages/sim/lab/b19/run.sh $a dry-h-$a --suite train --seeds 44 \
  --variants hidden,control,neutral --limit 2 --budget 1 $M > .local/b19/dry-h-$a.log 2>&1 & done; wait
python3 -I packages/sim/lab/b19/report.py --ledger .local/b19/ledger.jsonl --arm raw=.local/b19/runs/dry-h-raw \
  --arm before=.local/b19/runs/dry-h-before --arm final=.local/b19/runs/dry-h-final
```

`KIND=pi` runs the Pi arms the same way, and `--days 2 --day-size 20` gives either harness's days (one user a
seed; hermes-ab runs one stream a user, `HC` of them at once). `HERMES_SRC` is a
hermes-agent checkout at 06433066 whose `.venv` was installed from wheels only:
`UV_NO_BUILD=1 uv sync --project SRC --frozen --no-install-project --extra mcp`.

## 2. Pre-registration of the final run (committed before any heldout19 call; heldout19 is unread and unrun)

First committed as D1043 (Pi days). Amended by D1045 before the go: Hermes days was added once hermes-ab gained
`--days` (D1044), and the headline became Hermes short and Hermes days. Nothing else changed, and no heldout19 call
had been made.

- **Suite:** `heldout19` (P7, D870): 40 templates, with hidden, control and neutral variants, read once. Seeds
  41–44, the seeds shipped coverage covers (`SHIPPED_COVERS`).
- **Runs (`go.sh`, each once, in this order):**
  1. **Hermes, short (headline):** the three arms side by side. One process an arm runs all four seeds, with four
     workers and `--budget 6`. Expected: 480 tasks an arm.
  2. **Hermes, days (headline):** the three arms side by side. One process an arm runs all four users (one stream a
     user), `--days 2 --day-size 20` (heldout19's 40 templates bound a user) on the 1:1:8 mix, `--budget 4`. That is
     40 requests a user (16 hidden, 16 control and 128 neutral an arm) plus a recap a day.
  3. **Pi, short (secondary):** one seed a process, `--budget 2`. For each seed, the three arms run side by side.
  4. **Pi, days (secondary):** one user a process, `--days 2 --day-size 20`, `--budget 2`. For each user, the three
     arms run side by side.
- **Caps:** the ledger's hard cap is what the dry runs spent plus $25, at most $40 (`go.sh` computes it). No Modal.
  If the cap stops a step, the steps already finished stand, and the Pi steps are the ones that give way.
- **Before any call:** the parent's final commit is merged into this branch, and the harness is that tree.
  `tasks-hash.ts heldout19 41,42,43,44 2 20` must print the same hashes in the `before` and `final` trees, and only
  hashes and counts are printed.
  - If the final main adds a model role that hermes-ab or pi-ab does not wire, wiring it is part of the merge, and
    it is reported.
  - A process that crashes before writing its results is resumed with `--resume` (`--resume-biased` for an Eden arm
    under `--days`, marked so) and reported. A finished process is never run again (`run.sh` refuses).
- **Reading:**
  - Every metric of §1 is reported for every arm and every pair, short and days, on both harnesses.
  - The headline is **final − before, hidden raised, on Hermes short** (template-clustered, 40 clusters) **and on
    Hermes days** (user-day-clustered, 8 clusters). Each counts as a change only when its interval excludes 0.
  - Hermes days has 16 hidden tasks an arm, so it reads a direction, not a size.
  - Every control and neutral answer Sonnet flags as a concern is read by hand and reported with the verdict, since
    live false concerns overstate harm (fix-w2b).
  - No setting is changed after any result is seen.
- **Estimated cost:** about $7.5 in total, at rates from the dry runs on the final connector settings:

  | step        | $ per 1,000 tasks, by arm | estimate |
  | ----------- | ------------------------- | -------: |
  | Hermes short | 1.7–2.8                  |     $3.5 |
  | Hermes days  | 1.2–1.7                  |     $1.0 |
  | Pi short     | 1.3–1.8                  |     $2.2 |
  | Pi days      | 1.0–1.5                  |     $0.7 |

## Dry runs (train only)

Paid calls on train, Sonnet-graded. Raw files are in `.local/b19/runs/` (`dryN-*.json`, `.tl/`), the reports in
`.local/b19/dry*-report.json`, and the ledger in `.local/b19/ledger.jsonl`. These runs are small: they prove the
harness and price the final run, and **none of them is a result**.

| run       | harness, setting                                    | tasks an arm | hidden raw / before / final | Eden $/1k before / final | spend (3 arms) |
| --------- | --------------------------------------------------- | -----------: | --------------------------- | ------------------------ | -------------: |
| `dry1`    | Hermes, default profile, no change notices         |           18 | 0/6, 3/6, 3/6               | 0.59 / 0.57 (no check)   |          $0.12 |
| `dry2-h`  | Hermes, same (before the check was wired)           |           90 | 2/30, 22/30, 23/30          | 0.18 / 0.19              |          $0.55 |
| `dry3-h`  | Hermes, same, push check wired                      |           90 | 1/30, 23/30, 24/30          | 0.18 / 0.42              |          $0.56 |
| `dry4-ps` | Pi short, `direct`, payload, tenant prompt          |           90 | 1/30, 18/30, 23/30          | 0.17 / 0.40              |          $0.42 |
| `dry4-pd` | Pi days, 2 × 16, same                               |           32 | 0/4, 2/4, 3/4               | 0.21 / 0.40              |          $0.14 |
| `dry5-h`  | Hermes, `direct`, payload                           |           36 | 0/12, 8/12, 9/12            | 0.42 / 0.69              |          $0.26 |
| `dry6-hd` | Hermes days, 2 × 12, `direct`, payload (D1044)      |           24 | 0/2, 1/2, 2/2               | 0.32 / 0.51              |          $0.13 |

`go.sh` itself was rehearsed on train1, seed 42 (`SUITE=train1 SEEDS=42 PREFIX=reh EXTRA="--limit 1" FINAL=HEAD`).
It built both trees, the hashes matched, and all nine processes ran: Hermes short, Pi short and Pi days, 3, 3 and
40 tasks an arm, with 0 ungraded. It cost $0.23. `analyze.sh` (`PREFIX=reh SEEDS=42`) wrote the three reports.
After D1044 it was rehearsed again with Hermes days (`SEEDS=43 PREFIX=reh2`). All twelve processes ran (Hermes days
40 tasks an arm), with 0 ungraded, for $0.40, and `analyze.sh` wrote the four reports.

The resume test (`dry7-res`, Hermes days, final arm, train seed 42) was killed twice. The second time day 0 was in the
journal. A `--resume` without `--resume-biased` exited 2 with its reason. With it, the run reused day 0 at $0 ($0.0274
of earlier spend counted against `--budget`), ran day 1, wrote 24 results with `resumed.biased` true and deleted the
journal.

In every dry run with the check wired, the `final` arm hands a packet on fewer neutral turns. The counts are
18/30 vs 29/30 (dry3-h), 16/30 vs 28/30 (dry4-ps), 8/24 vs 21/24 (dry4-pd) and 5/12 vs 12/12 (dry5-h), and the
check's calls (`eden.check`, $0.21–0.26 per 1,000 tasks) are the new Eden cost line.

### Review before the go

An independent reviewer read the harness diff and ran typecheck, format and `bun run test:pkg sim` (69 files pass),
with no paid calls and nothing on heldout19. It confirmed the push check is booked once in both Eden arms
(5026ba512's traces already carry `checkCalls`), and that `--days` and the journal follow pi-ab point by point. Its
fixes, made before the go:

- **Tool calls counted for the whole day.** Under `--days`, `worker.py` counted every tool call since the start of
  the day. The cause is that Hermes returns the history plus the new turn. It now counts the request's own turn:
  `dry8-hd-raw`, 12 requests, every count equals the timeline's spans. `report.py` already read the spans, so the
  B19 figures were never affected.
- **A failed arm did not stop the run.** `go.sh`'s bare `wait` let a failed arm pass, so the next step would spend
  anyway. It now waits on each arm and stops before the next step (checked at $0).
- **Partial arms were not flagged.** `report.py` now prints a NOTE for an arm that is partial, has stopped streams,
  errored tasks or reused units, BIASED included.
- **`arm-tree.sh` and renames.** It now diffs with `--no-renames` and stages its deletions, so `productHash` is the
  tree's own (its index has no diff against 5026ba512).

Left as they are:

- **hermes-ab's `--days` and `--resume` have no unit test.** The suite cannot run Hermes; the evidence is the train
  runs above.
- **The tasks-hash gate shows less than it might seem.** Both trees share `packages/sim`, so it only shows that
  Eden's packages do not change how the tasks and worlds are built.
- **Eden's $/1k:** the numerator includes recap turns and errored tasks, and the denominator counts only the tasks
  that finished. The same rule applies to every arm.

## 3. Results

To be filled in after the parent's go.
