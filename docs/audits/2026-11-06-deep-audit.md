# Deep audit (2026-11-06)

## Final summary (for the owner, read this first)

Written at the end of the run, from `audit/2026-11-06-integration` 841fed61e (2 rounds plus 2 closing passes). Every
number here comes from the decision log (docs/DECISIONS.md), the package commits, or a command run while writing this
summary. Estimates are labelled. The older summaries further down are kept as history; where they disagree with this
one (for example, "D159 was not promoted"), this one is current.

A few words used below:

- **Hidden facts / decoys.** The test lab plants 384 facts the agent needs ("hidden") and 384 look-alikes it must not
  be told about ("decoys"). More hidden found is better; fewer decoys shown is better.
- **Reader.** The small paid model (Claude Haiku) that reads candidate items and decides what matters.
- **Intent.** Eden guesses, ahead of time, which requests each item could answer, so it can find the item later.
- **Train / held-out.** Train suites are used for tuning. Held-out suites are kept back to check the result.
- **Trial.** New behaviour behind a switch, with a rule fixed in advance that either promotes it or deletes it (D112).

### 1. The bottom line

The test bench was measuring a product that does not ship (intent switched off), so earlier quality numbers were too
low and some decisions rested on the wrong baseline. That is fixed, and the shipped default now finds 311 of 384 hidden
facts on the train replay, against 273 when the bench was first corrected, with decoys unchanged at 137. On
the held-out live check it raised hidden 97 to 103 of 128, at no measured extra cost. Two bugs that let a deleted
message or document come back and be delivered are fixed. The server now uses every core by default (about 3.2x the
events per second on 4 cores), and a big tenant knowledge base no longer blocks the server for a third of a second on
every search. Two ideas meant to cut cost or raise recall were built, measured and deleted because they did not pass
their own rules.

### 2. Findings by dimension

"Closed by a decision" means the finding was true but the right move was to write it down, not change code (a ceiling,
a measured no-win, or a trial that failed its gate). "Rejected" means the verifiers did not confirm it.

| Dimension   | Found  | Rejected | Verified | Fixed and reviewed | Closed by a decision | Still open |
| ----------- | ------ | -------- | -------- | ------------------ | -------------------- | ---------- |
| Quality     | 12     | 2        | 9        | 7                  | 2                    | 1          |
| Correctness | 7      | 1        | 5        | 5                  | 0                    | 1          |
| Dev loop    | 13     | 1        | 6        | 5                  | 5                    | 2          |
| Cost        | 5      | 2        | 2        | 0                  | 3                    | 0          |
| Scale       | 9      | 2        | 3        | 3                  | 2                    | 2          |
| Latency     | 7      | 1        | 3        | 0                  | 3                    | 3          |
| Moonshot    | 2      | 1        | 1        | 0                  | 1                    | 0          |
| Pain point  | 3      | 1        | 0        | 1                  | 0                    | 1          |
| **Total**   | **58** | **11**   | **29**   | **21**             | **16**               | **10**     |

Where the ledger and git disagree, or the ledger is silent:

- 18 found findings are in neither the ledger's verified list nor its rejected list, yet the ledger's "unresolved"
  list is empty. Seven are old 2026-11-05 items (O5, O8, O9) that D180 closed; they are counted under "Closed by a
  decision". One (`docs-stale-funnel-preset-and-blind`) is already corrected on the integration branch (root
  CLAUDE.md no longer says "preset ALL3"; the `UNRUN_BLIND` comment says held-out 9-13 were read), so it is counted
  as fixed. The other 10 have no record anywhere in docs/ and are counted as still open (section 5).
- The ledger's deferred list still says round 1's F5, F6 and F10 "stay open". Git says otherwise: F5 is fixed (commit
  f086b5605 is in the integration branch), F6's trial was built and deleted (f7fd5f0ca, D186), and F10 is closed
  (D184).
- `devloop-test-changed-engine-runs-e2e`: the ledger says 18.6 to 9.35 s, D161 says 17.96 to 8.91 s. Both are 2.0x;
  they are different runs.
- Every one of the 21 package branches the ledger names is merged into `audit/2026-11-06-integration` (checked with
  `git branch --merged`). The integration branch itself is **not** merged into `origin/main` yet.

### 3. What was achieved

One row per merged package branch, in merge order. Train figures are train1-6, seeds 41-42. "Recipe 2a" is the $0
replay of the committed paid reader cache (docs/LAB.md).

| Package (branch suffix)          | The fix                                                                   | Measured before -> after                                                                                                        | Outcome                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `r1-intent-shipped-baseline`     | The lab tests the shipped default (intent on) (D158)                      | Stub reader pool 230/229 -> 257/240 hidden/decoys; "never ranked" gap 92 -> 64 of 384; paid read 247/127 -> 279/133             | Shipped as the lab's default                                                                  |
| `r1-sourceitems-removal-race`    | A delete during redaction is no longer undone (D160)                      | Bug reproduced twice -> fixed; no model call, no I/O                                                                            | Shipped as default                                                                            |
| `r1-test-changed-defer-e2e`      | Fast test loop skips six end-to-end files; `check` still runs them (D161) | Engine-edit `test:changed` 17.96 -> 8.91 s (2.0x)                                                                               | Shipped (dev tooling)                                                                         |
| `r1-ask-diag-coverage`           | `--ask-diag` says why an item is never ranked (D162)                      | The 64 never-ranked hidden facts split into 21 with no intent requests and 43 with requests that do not match                   | Shipped (lab tooling)                                                                         |
| `r1-server-router`               | Multi-process server router (D163)                                        | 4 children vs 1 process: 2.15x and 2.06x events/s on 4 shared cores                                                             | Behind a flag (`EDEN_PROCESSES=1`): the gate swung across 1.5x between runs; promoted by D178 |
| `r1-graph-soa`                   | Graph stored as typed arrays (D169)                                       | Graph memory 1,703 -> 719 B/item (2.37x); walks identical over 200 seeds                                                        | Shipped as default                                                                            |
| `r1-close-docs-ceilings`         | Four ceilings written down (D164-D167)                                    | Docs only                                                                                                                       | Recorded                                                                                      |
| `r2-intent-constraint-only`      | Stop reading items for intent alone (D170)                                | Card model items 13,604 -> 2,113, calls 822 -> 300; role cost about 4.5x lower (estimate)                                       | Removed (D177): fresh paid pair hidden 286 -> 281, decoys 140 -> 144, outside its gate        |
| `r2-intent-replay-coverage`      | Intent replay covers every planted fact and held-out 13                   | Intent file 6,771 -> 7,315 lines; planted coverage 286/384 -> 384/384 hidden; recipe 2a 273/137 -> 281/139                      | Shipped (lab data)                                                                            |
| `r2-pi-cost-cache-neutral`       | Cost check ignores prompt-cache luck between arms (D171)                  | D159's 47 same-ask pairs: billed +0.0461 $/1k -> cache-neutral -0.0002 $/1k                                                     | Shipped (lab report)                                                                          |
| `r2-removal-sequence`            | A second delete during redaction is no longer undone (D176)               | Bug reproduced by three agents -> fixed; heap per hold 176 -> 208 B                                                             | Shipped as default                                                                            |
| `r2-router-hardening`            | A hung restarted child is killed and retried; bench uses medians (D172)   | Hung child stayed down (503) -> restarted with backoff; tests split into two files                                              | Shipped as default                                                                            |
| `r2-static-source-index`         | Inverted index for the built-in static source (D175)                      | Per search at 4,000 docs 38.3 -> 0.351 ms (109x); at 40,000 docs 34.3 -> 2.64 ms; heap 4,575 -> 246 B/doc                       | Shipped as default                                                                            |
| `r2-kg-oracle-seeds`             | Fast loop runs 25 graph-test seeds, `check` runs 200 (D176)               | `kg.test.ts` 5.97-6.91 s -> 1.87-2.34 s in `test:changed`; median about 1.18x on the engine set                                 | Shipped (dev tooling)                                                                         |
| `r2-ask-diag-precision-split`    | Lab splits shown decoys by cause (D173)                                   | 137 decoys shown = 23 reader-flagged + 68 rule path + 46 listed only                                                            | Shipped (reporting only; gates unchanged)                                                     |
| `final1-intent-closeout`         | Looser intent thresholds 0.2/1/12 (D179); trial D170 ended (D177)         | Held-out 13 live: hidden 97 -> 103 of 128, false concerns 2 -> 1, cost -0.0453 $/1k (CI -0.1164..+0.0268); recipe 2a 281 -> 311 | Shipped as default                                                                            |
| `final1-router-default`          | Server uses every core by default (D178)                                  | 1,169 -> 3,759 events/s on 4 shared cores (median 3.23x, lowest 3.22x)                                                          | Shipped as default                                                                            |
| `final1-funnel-parallel-diag`    | Diagnostic lab runs use every core (F5)                                   | `--ask-diag` 27.8 -> 12.6 s (2.21x); repeat 33.8 -> 18.5 s (1.83x); output byte-identical                                       | Shipped (lab tooling)                                                                         |
| `final1-close-docs-2026-11-06`   | Decisions D177-D182 and the closing section                               | Docs only                                                                                                                       | Recorded                                                                                      |
| `final2-action-gate-verbs-trial` | Reader also reads requests whose verb was missing from a list (D186)      | Recipe 2a hidden 311 -> 310, decoys 137 -> 121, reader calls 651 -> 764 (+17.4%)                                                | Removed by its pre-set rule (needed hidden +3 and calls at most +10%)                         |
| `final2-close3-docs-decisions`   | Decisions D183-D186 and closing pass 3                                    | Docs only                                                                                                                       | Recorded                                                                                      |

Paid spend: the spend ledger sums to $14.51 over 56,501 rows (a `bun -e` sum run while writing this). It held $11.49
when round 1 was written, so about $3.02 was spent after that point (estimate: it does not split out the finders'
earlier runs). About $3.19 is left under the $18 cap and its $0.30 headroom.

### 4. Decisions made during the run

| Decision                                                                   | Evidence                                                                            | Row  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---- |
| The lab screens the shipped default (intent on)                            | Stub pool 230/229 inert vs 257/240 with intent                                      | D158 |
| Loosen intent thresholds once a live pair agrees; first pair: not promoted | Train paid pairs +17-21 hidden; first Pi pair cost +0.070 $/1k (later found biased) | D159 |
| A removal during redaction wins                                            | Reproduced twice in a scratch test                                                  | D160 |
| Fast test loop defers six end-to-end files                                 | 17.96 -> 8.91 s                                                                     | D161 |
| The ask's lexical depth stays at 12, reader pool at 15                     | Cap 12 -> 60 moved the pool 257/240 -> 258/237 only                                 | D162 |
| Build the multi-process router as a trial, caps divided by N               | 2.15x and 2.06x events/s on 4 cores                                                 | D163 |
| No prompt cache for reader items                                           | At most 1.17-1.28x on reader cost (estimate)                                        | D164 |
| Eden's path is reader time; no 1.5x on task wall below the model           | Reader is 94.5% of Eden's path on hidden tasks                                      | D165 |
| Do not move the push reading off the agent's start                         | 66 of 75 useful pushes end in single-request tasks                                  | D166 |
| Do not overlap the ask's reader with its poll                              | Upper bound 1.13-1.14x on ask batches                                               | D167 |
| Reject the "action unless it is a question" rule                           | Chat lines like "thanks!" and "Lol" became paid reader calls                        | D168 |
| Graph moves to typed arrays only if its memory halves                      | Passed: 1,703 -> 719 B/item                                                         | D169 |
| Trial: skip intent-only card reads                                         | Items 13,604 -> 2,113 at an equal $0 screen                                         | D170 |
| Paired cost checks use cache-neutral prices                                | Billed +0.0461 vs neutral -0.0002 $/1k on identical asks                            | D171 |
| Router trial decided on a median of 3 or more runs; restart deadline       | Single runs landed at 1.32x to 3.70x                                                | D172 |
| Lab reports shown decoys by cause; gates unchanged                         | 23 of 137 decoys were reader-flagged                                                | D173 |
| Do not rank asks on question plus request                                  | Paid reader: hidden +0.5 points, CI -2.1..+3.1                                      | D174 |
| Static source gets lazy term sets, then an inverted index                  | 109x per search at 4,000 docs                                                       | D175 |
| 25 graph-test seeds in the fast loop; per-hold sequence for removals       | `kg.test.ts` 1.87-2.34 s at 25 seeds; second-removal bug reproduced                 | D176 |
| End trial D170 and delete it                                               | Fresh paid pair hidden 286 -> 281, decoys 140 -> 144                                | D177 |
| `EDEN_PROCESSES` defaults to the core count                                | Median 3.23x, lowest 3.22x                                                          | D178 |
| Promote intent thresholds 0.2/1/12                                         | Held-out 13 live pair passed all three pre-set parts                                | D179 |
| Close the 2026-11-05 audit's O5, O8 and O9 with no code change             | 25 of 25 test passes; ceilings below 1.5x                                           | D180 |
| Do not compress item text                                                  | About 1.42x per item (estimate), below the 1.5x bar                                 | D181 |
| F6, F10 and F25 wait for D179 (superseded by D184-D186)                    | They had to be screened on the final thresholds                                     | D182 |
| Keep `fallbackAsks` in the default                                         | Removing it changes 4 decoys from two templates; eval loses precision and recall    | D183 |
| Close request-side query expansion, not built                              | 45 of 384 unranked at top 60; about 3-6 tasks to gain (estimate)                    | D184 |
| Do not build unordered subset replay                                       | A paid arm costs about $0.19; ordered replay already matched only 493 of 600        | D185 |
| Trial the verb-recognising reader gate; deleted by its rule                | Hidden 311 -> 310, reader calls +17.4%                                              | D186 |

### 5. What is still open, and why

| Item                                                                             | Why it is open                                                                                                                                | Next step                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The integration branch is not merged into `main`                                 | External action: merging is the last step and has not been done                                                                               | Open a PR from `audit/2026-11-06-integration`, run `bun run check` and `bun run eval` on it, merge |
| `bun run eval` was not run on the final tree 841fed61e                           | The sandbox refused any command containing "eval" during the last merge; the engine source did not change since 397c78b00, where eval matched | Run `bun run eval` on 841fed61e before the merge to `main` and paste the JSON in the PR            |
| No blind held-out suite is left (`quality-no-unspent-blind-suite`)               | Held-out 9-13 have all been read; any "blind" claim would be false                                                                            | Write a new held-out suite before the next decision that needs a blind check                       |
| `correctness-kg-day-node-utc`: the graph files an event's day in UTC             | Found, never verified or rejected; no doc records it                                                                                          | Verify in the next audit round; if true, use the user's offset as the pass-2 timed-zone fix did    |
| `devloop-sim-test-longest-file`: `sim.test.ts` takes 6.2 s                       | Found, never verified or rejected; no doc records it                                                                                          | Verify next round                                                                                  |
| `devloop-funnel-set-after-dashdash`: `--set` after `--` gives a poor error       | Found, never verified or rejected; no doc records it                                                                                          | Verify next round; a clearer error message is the likely fix                                       |
| `scale-router-gate-workers-multiply`: each router child starts its own gate pool | Found, never verified or rejected; it matters more now that the router is on by default (D178)                                                | Verify next round, first of these                                                                  |
| `scale-shared-source-copied-per-user`: tenant-wide documents copied per user     | Found, never verified or rejected; no doc records it                                                                                          | Verify next round                                                                                  |
| `lat-draft-speculative-read-pool-drift`                                          | Found, never verified or rejected; no doc records it                                                                                          | Verify next round                                                                                  |
| `lat-reader-entry-cap-unenforced`                                                | Found, never verified or rejected; no doc records it                                                                                          | Verify next round                                                                                  |
| `lat-reader-stream-settle-binding-first-measured`                                | Found, never verified or rejected; no doc records it                                                                                          | Verify next round                                                                                  |
| `integrator-example-works-port-naming`: `PORT`, not `EDEN_PORT`, in the example  | Found, never verified or rejected; no doc records it                                                                                          | Verify next round                                                                                  |
| 11 findings rejected by the verifiers (listed in the ledger)                     | Rejected by review: not confirmed, or not material                                                                                            | None; reopen one only with a new measurement                                                       |

Nothing waits for paid spend beyond the budget. Two options are recorded but not open: promoting the verb gate for its
decoy cut alone would need a new decision accepting +17% reader calls (D186), and query expansion reopens if more than
15% of hidden facts become unranked (D184).

### 6. Where everything is

- This audit: `docs/audits/2026-11-06-deep-audit.md` (rounds 1 and 2, the closing sections, and this summary).
- Decisions: `docs/DECISIONS.md` rows D158-D186; the trials table below them.
- The integration branch: `audit/2026-11-06-integration` (841fed61e before this summary).
- Per-package branches, all merged into the integration branch:
  - Round 1: `audit/2026-11-06-r1-intent-shipped-baseline`, `-r1-sourceitems-removal-race`,
    `-r1-test-changed-defer-e2e`, `-r1-ask-diag-coverage`, `-r1-server-router`, `-r1-graph-soa`, `-r1-close-docs-ceilings`.
  - Round 2: `audit/2026-11-06-r2-intent-constraint-only`, `-r2-intent-replay-coverage`, `-r2-pi-cost-cache-neutral`,
    `-r2-removal-sequence`, `-r2-router-hardening`, `-r2-static-source-index`, `-r2-kg-oracle-seeds`,
    `-r2-ask-diag-precision-split`.
  - Closing: `audit/2026-11-06-final1-intent-closeout`, `-final1-router-default`, `-final1-funnel-parallel-diag`,
    `-final1-close-docs-2026-11-06`, `-final2-action-gate-verbs-trial`, `-final2-close3-docs-decisions`.
- Research notes behind the numbers: `docs/research/edge-intent.md`, `docs/research/graph-soa.md`,
  `docs/research/pi-cache-neutral-cost.md`, `docs/research/new-minus-intent.md`.

## Round 1 summary (history; the final summary above is current)

Written on 2026-11-06 from `main` a8747e057. Every number below comes from a command that the finder or one of the
two independent verifiers ran (named in each finding), or is labelled an estimate with its arithmetic. Paid calls go
only to Anthropic (`HAIKU_API_KEY`, `claude-haiku-5-5` for every role), metered with `--spend-ledger
.local/mkt/ledger.jsonl --spend-cap 18 --spend-headroom 0.3`. The ledger summed to $11.49 (45,072 rows, a `bun -e`
sum run while writing this report), so about $6 is left under the cap.

What this audit found, in plain words:

- **The test bench was measuring a product that does not ship.** The shipped default turns on "intent" (Eden guesses,
  ahead of time, which requests each item could answer). The $0 screen and the checked-in paid replay both ran with
  intent switched off, because the funnel never loads the intent file that is already in the repo. The shipped
  default really finds about 278 of 384 hidden facts on train, not the 247 every recent decision quotes, and the
  "facts the ask never ranks" gap is 64, not 92. Fix: load intent by default in the funnel and record a matching
  replay cache (about $0.07-0.19).
- **A free quality gain is on the table.** Loosening intent's three match thresholds (coverage 0.35 to 0.2, matched
  terms 2 to 1, hits 6 to 12) raised hidden facts found by 17-21 of 384 in three independent paid train runs, with
  decoys flat (-4 to +1), the same number of reader calls, and gains on unseen seeds and a blind held-out suite. It
  costs nothing extra on train. Decision D159 made it conditional on one live Pi pair; that pair showed a cost
  rise, so it was not promoted (round 2 found the pair intent-inert and its cost rise a prompt-cache artefact, and
  reopened it).
- **One correctness bug.** If a connector sends an edit and then a delete close together, the delete can be undone:
  the deleted item comes back and can be delivered until the next sweep. Reproduced twice in a scratch test. Fix is
  small and adds no cost.
- **The developer loop.** After an engine edit, `bun run test:changed` runs 84% of the whole suite because six
  end-to-end simulation files ride along. Deferring them to `bun run check` halves the inner loop (18.0 to 8.9 s,
  measured). Diagnostic funnel runs are forced onto one process (2.2-2.4x slower); that fix waits for round 2 because
  it edits the same file as the intent fix.
- **Scale.** The server still runs every user on one core: the multi-process router D113 decided on was never built.
  Four processes measured 1.8-2.2x the throughput of one on a 4-core box. A struct-of-arrays graph would cut memory per
  user, but a verifier's breakdown puts it at about 1.6x on the graph's share, not the 2.5-2.9x claimed.
- **Ceilings, recorded so nobody chases them again.** Eden's time on the agent's path is about 94% reader model time;
  no change below the model can give 1.5x on task wall time. Caching the reader's items across calls gives at most
  about 1.17-1.28x on reader cost. Moving the push reading off the agent's start loses most useful pushes. Overlapping
  the ask's poll with the reader gives at most 1.13x on asks.

Round 2 (planned after round 1 merged) is summarised in plain words at the top of its section, "Round 2" below:
15 more verified findings, 8 packages, D170-D176.

Seven work packages go to parallel fixers in round 1 (below). Three findings wait for round 2 because they edit files
a round 1 package owns or need its output: the action-request gate (needs the intent-on cache and edits `config.ts`),
parallel funnel diagnostics (edits `funnel.ts` and `hidden-funnel.ts`), and request-side query expansion (needs the
new baseline and the new diagnostics).

## Findings, ranked by value

Severity first, then effort. "Status" is where the finding stands after this round's planning.

| #   | Finding                                     | Severity | Effort | Status                                                                            |
| --- | ------------------------------------------- | -------- | ------ | --------------------------------------------------------------------------------- |
| F1  | `quality-intent-thresholds-unranked`        | medium   | S      | Round 1, package `intent-shipped-baseline`; D159                                  |
| F2  | `quality-o7-measured-intent-inert`          | medium   | S      | Round 1, package `intent-shipped-baseline`; D158                                  |
| F3  | `correctness-pushed-items-undo-deletion`    | medium   | S      | Round 1, package `sourceitems-removal-race`; D160                                 |
| F4  | `devloop-test-changed-engine-runs-e2e`      | medium   | S      | Round 1, package `test-changed-defer-e2e`; D161                                   |
| F5  | `devloop-ask-diag-forces-one-process`       | medium   | S-M    | Deferred to round 2 (waits for `intent-shipped-baseline` and `ask-diag-coverage`) |
| F6  | `quality-push-skipped-imperative-list`      | medium   | S      | Deferred to round 2 (waits for `intent-shipped-baseline`); D168                   |
| F7  | `quality-o7-remaining-gap-not-candidates`   | medium   | M      | Round 1 stage 1, package `ask-diag-coverage`; D162                                |
| F8  | `scale-multi-process-router-unbuilt`        | medium   | M      | Round 1, package `server-router`; D163                                            |
| F9  | `scale-graph-soa-and-compact-text`          | medium   | L      | Round 1 stage 1, package `graph-soa`; D169; stage 2 deferred                      |
| F10 | `moonshot-ask-query-expansion-ceiling`      | medium   | L      | Deferred to round 2 (waits for `intent-shipped-baseline` and `ask-diag-coverage`) |
| F11 | `lat-eden-path-is-reader-floor`             | low      | S      | Round 1, package `close-docs-ceilings`; D165                                      |
| F12 | `cost-reader-prompt-cache-items-impossible` | low      | S      | Round 1, package `close-docs-ceilings`; D164                                      |
| F13 | `lat-push-off-path-kills-hidden`            | low      | S      | Round 1, package `close-docs-ceilings`; D166                                      |
| F14 | `lat-ask-reader-overlap-poll-closed`        | low      | S      | Round 1, package `close-docs-ceilings`; D167                                      |

### F1. Looser intent thresholds recover unranked facts at no extra cost

- **Evidence.** The thresholds are `intentHits: 6`, `intentMinCoverage: 0.35`, `intentMinMatched: 2`
  (`packages/engine/src/config.ts:576-578`), applied per request at `packages/engine/src/partner.ts:4473` and capped at
  :4475. Of the 64 hidden facts the ask never ranks with intent on, 54 were not among the top 6 intent hits. Example:
  `contents-cover-switched` ("Accept Harbourside's renewal quote for my contents insurance") shares "contents" and
  "insurance" with the item's intent requests but misses the per-request bar. Decoys use the same wording
  (`packages/sim/src/lab/hidden-train1.ts:249-275`).
  - $0 stub screen, train1-6 seeds 41-42, intent replayed (`bun run funnel --jobs 4 -- --intent F [--set
'{"intentMinCoverage":0.2,"intentMinMatched":1,"intentHits":12}']`): reader pool 257/240 to 270/246
    (hidden/decoys). Reproduced exactly by both verifiers.
  - Paid Haiku pairs, fresh cache per arm (three independent runs): 277/135 to 296/132 (finder; paired hidden +4.95
    points, 95% CI +2.05..+7.84; decoys -0.78, CI -3.80..+2.24; 653 vs 655 calls); 274/136 to 295/132 (verifier 1,
    about $0.37); 277/133 to 294/134 (verifier 2, about $0.37). Run-to-run spread is about ±3 tasks.
  - Unseen seeds 43-44 (finder only, not re-run): 275/147 to 292/137. Blind held-out 10-11 (finder only): 77/44 to
    85/39.
  - `bun run eval` unchanged with the loose config (precision 0.8276, recall 0.48, falseFireRate 0; verifier 2): intent
    is inert in eval. The no-model path does not move (stub JSON: hidden delivered 98, decoys delivered 72 in both
    arms).
- **Impact.** Misses 107 to 88-90 on seeds 41-42 (about 1.2x fewer), same reader calls and cost. The 1.64x unranked
  and 1.32x decoy figures belong to a wider variant (hits 40, coverage 0, matched 1) combined with F6's gate; that
  variant alone raised decoys on never-read tasks (35 to 41), so it waits for F6.
- **Fix.** Promote 0.2/1/12 into `DEFAULT_CONFIG` (D159) after one live Pi held-out 13 pair confirms it (outcome: not
  promoted, see D159's result and round 2's F18 and F20); unit tests that
  a one-term intent hit can enter an ask's pool but is never a no-model delivery.
- **Status.** Round 1, package `intent-shipped-baseline`.

### F2. The $0 screen and the replay cache measure the default with intent off

- **Evidence.** `intent: true` is in `DEFAULT_CONFIG` (`packages/engine/src/config.ts:573`, D87/D125).
  `packages/sim/src/lab/funnel.ts:154-163` merges only the cards caches; `funnel.ts:24-25` and `:134-138` only warn
  when intent is on and no file is given, so every TOTAL line reads "[intent inert: no replay]". `docs/LAB.md:302`
  says the intent file is "not checked in"; `docs/LAB.md:89` and the file itself say otherwise
  (`packages/sim/lab/distilled/intent-v2.jsonl.gz`, 6,771 lines, train seeds 41-44 and held-out 10-11).
  - Stub funnel, `bun run funnel --suite train --seeds 41,42 --jobs 4 -- --packet-k 15,30,60`, without and with
    `--intent F` (verifier 1): pool hidden 230 to 257, decoys 229 to 240; top-15 hidden 265 to 275; top-30 287 to 309;
    top-60 hidden 292 to 320, decoys 299 to 307. Unranked hidden 92 to 64.
  - Replay of the committed reader cache (`--reader replay --reader-model claude-haiku-5-5 --allow-misses --jobs 4`):
    intent off replays 648 and misses 5 (TOTAL 247/127, 13.4 s); intent on replays 396 and misses 489.
  - Paid top-up with intent on (verifier 1, ledger-metered, $0.0743, 257 calls): hidden 279/384, decoys 133/384, 0
    misses. The finder's runs gave 276-279 / 133-137 (e.g. ledger run `audit3-intent-default-topup`, 255 calls,
    $0.0735). Paired against the inert replay (finder, not re-run): hidden +31, CI [+19.1, +42.9].
- **Impact.** Every reader or retrieval change is screened against a configuration that does not ship: it understates
  the shipped hidden score by about 31 tasks and overstates the unranked gap 1.44x (92 vs 64). Nothing that ships
  behaves differently, hence medium. Dev loop: an intent-on answer costs about 205 s and $0.07 today; with a committed
  intent-on cache it is a 10-13 s replay at $0 (estimate from the measured replay time).
- **Fix.** Funnel loads the committed intent replay by default when the config has intent and the file covers the
  run's suites and seeds (`--intent none` opts out; the header prints the state); record and commit an intent-on Haiku
  reader cache; relabel (not rewrite) intent-inert numbers in LAB.md and the root CLAUDE.md funnel line. The existing
  `intentMismatch` baseline check (`funnel.ts:143-151`) already refuses old inert `--baseline` files. Note for the
  fixer: the run label flag is `--run-label` (`free.ts:87`), not `--spend-run`.
- **Status.** Round 1, package `intent-shipped-baseline` (with F1, since both change what the cache must hold).

### F3. A deletion that lands while pushed items are being redacted is undone

- **Evidence.** `packages/engine/src/partner.ts:1767-1781` (`sourceItems`): `await this.redact(own)`, then
  `cache.revive(scope, ids)` and `sync.ingest(...)` with no check that the id was removed during the await.
  `sourceRemoved` (:1789) runs `dropGone` (:3604), which sets the gone-hold; the later `revive` lifts it. The re-read
  path does check (`partner.ts:3576-3584`). Both verifiers reproduced it in a scratch bun test (`p =
sourceItems(edited q1); sourceRemoved(['q1']); await p`), printing `removed 1 cached after The quarterly offsite
moved to Porto on 19 November. heldGone false`, with an async gate pool and also with the inline sanitizer.
- **Impact.** Deleted content stays cached and deliverable until the next sweep; breaks D126. Over HTTP with the
  default 0 gate workers the continuation runs as a microtask before the next request, so in practice it needs
  `EDEN_GATE_WORKERS > 0` or an embedder calling the methods without awaiting.
- **Fix.** `sync.mark()` cannot be used: it counts change signals and `sync.removed()` / `dropGone` never bump it
  (`sync.ts:305-321`, verifier 2). Before the await, note which sanitized ids are already held gone; after it, drop from
  `clean` any id held gone now but not before; revive and ingest the rest. A push after an earlier deletion still
  revives (the source sent it again). Regression tests with and without an async gate pool; update the engine
  CLAUDE.md pitfall.
- **Status.** Round 1, package `sourceitems-removal-race`.

### F4. `test:changed` after an engine edit runs most of the suite

- **Evidence.** `scripts/test-select.ts:83-108` adds every dependent of a touched package: engine pulls in server,
  eval and sim (`examples/personal-agent` depends only on `@eden/client`, so it is not included). Verifier 1 (4 cores):
  `bun scripts/test-select.ts pkg engine sim server eval` 17.96 s, 1,062 pass, 93 files; without `sim.test.ts`,
  `funnel-flags.test.ts`, `reader-stub.test.ts`, `deletes.test.ts`, `gate-traffic.test.ts` and
  `packages/eval/src/run.test.ts`: 8.91 s, 991 pass, 87 files.
- **Impact.** Engine inner loop 2.0x faster. `bun run check` unchanged and still runs every file. Cost: an engine
  change only the end-to-end simulation catches is found at `check`, not at `test:changed`.
- **Fix.** A deferred list in `test-select.ts` (not a rename: package CLAUDE.md files and docs name these files). Skip
  them only when their package is a dependent, never when it changed; print the skipped files and the command to run
  them. Test case in `scripts/test-select.test.ts`; document in docs/TESTING.md.
- **Status.** Round 1, package `test-changed-defer-e2e`.

### F5. Diagnostic outputs and live top-ups force the funnel onto one process

- **Evidence.** `packages/sim/src/lab/funnel.ts:213-218` builds `soloReasons` from `--packets`, `--card-log`,
  `--reader-log`, `--ask-diag`, `--candidates`, `--timeline`, `--record`, `--judge live` and `--reader live`; `:224-227`
  forces `jobs=1`. `hidden-funnel.ts:423-424` truncates the diag file at start, so shards would clobber each other as
  the code stands. Replay with `--ask-diag`: 24.4 s; without: 10.1 s (verifier 1, 2.4x; finder 2.15x). Ledger:
  `audit3-intent-default-topup` 255 calls over 181 s with 299 s summed latency (1.65 in flight).
- **Impact.** Diagnostics 2.2-2.4x faster (measured). Paid top-ups 3-4x faster is an estimate nobody measured; rate
  limits may bound it.
- **Fix.** Per-shard outputs (`<out>.part-N`, `<cache>.part-i`) merged afterwards like `mergeParts`; spend shared
  through the ledger with headroom covering N processes. Keep solo for `--record` and `--timeline` (per-process CPU and
  RSS would be contended); treat `--judge live` like `--reader live`. Proof compares diag files under one canonical
  sort, not the one-process order.
- **Status.** Deferred to round 2: it edits `funnel.ts` (owned by `intent-shipped-baseline`) and `hidden-funnel.ts`
  (owned by `ask-diag-coverage`).

### F6. The reader never reads one action request in six

- **Evidence.** The push starts only if `isImperative(event.text, MORE_VERBS)` (`packages/engine/src/partner.ts:668`);
  `readAsk` returns null unless imperative or `ASKS_BLOCKERS` (`partner.ts:1519-1521`); `isImperative`
  (`packages/engine/src/probes.ts:63-75`) accepts only `LEADING` or `MORE_VERBS` verbs. Both verifiers counted 124 of
  768 train tasks `readerOutcome: "skipped"` (62 hidden, 62 control, 31 templates, 38 distinct requests) from `bun run
funnel --json`. Openers include Switch, Cash in, Open, RSVP, Agree, Spin up, Promote, Export. Finder's paid runs
  (not reproduced): hidden +2 to +5 of 384 with intent on, CIs including zero; decoys -6 to -8.
- **Counter-evidence (verifier 2).** The proposed closed-class rule (an action unless it ends in "?" or starts with a
  pronoun, determiner, wh-word, auxiliary or preposition) treats "thanks!", "ok sounds good", "Lol", "Yes", "Done",
  "Got it", "Sam says hi" and "Good news: the offsite is on" as actions, and misses "When you do ...". Each would start
  a paid reader push from observe and use up the session Budget (20 calls, $0.02), which the funnel does not apply.
  The train funnel has one request per task, so it cannot see that cost.
- **Impact.** A correctness gap (16% of action requests not treated as actions) with an end-to-end gain of about 1-2
  points; real but small.
- **Fix.** D168: reject the closed-class rule; recognise verbs instead (wider verb list or a first-word verb check),
  block a short list of chat replies, measure on a suite with non-request messages and the Budget on, behind a trial
  switch with a COST-MODEL.md line.
- **Status.** Deferred to round 2: it must be screened on the intent-on cache and thresholds that
  `intent-shipped-baseline` produces, and its trial switch edits `packages/engine/src/config.ts`, which that package
  owns.

### F7. The remaining unranked facts are not candidates at all

- **Evidence.** `rank()` takes BM25F's top 12 (`partner.ts:2039`, `cache.search(s.scope, query, query.length, 12,
...)`). Stub with intent on and `--ask-diag` (both verifiers): 64 of 384 hidden at rank -1; median candidate list 21
  (5-61). Cap 12 to 60 in a scratch copy: pool hidden 257 to 258, decoys 240 to 237, top-15 hidden 275 to 262, rank -1
  64 to 61. Intent inert: 92 at rank -1 across 50 of 192 templates. Not reproduced: the reader flag rates and prompt
  bytes.
- **Impact.** Raising the lexical cap or the pool gives no net gain; the lever is a request-to-item bridge.
- **Fix.** D162: the cap stays at 12. Stage 1 ($0): `--ask-diag` says whether the planted item has intent requests
  and whether cards lean-skipped it, separating missing coverage from a bridge that does not match. Later trials
  (`intentConstraintAll`, which does not exist yet and would need a COST-MODEL.md estimate first) wait for that answer.
- **Status.** Round 1 stage 1, package `ask-diag-coverage`: done. Train1-6, seeds 41-42, stub reader, cards
  replayed, `bun run funnel --jobs 1 -- --intent <gunzipped packages/sim/lab/distilled/intent-v2.jsonl.gz>
--ask-diag F` (768 rows; every other line, `cards use` calls 822 included, identical to the run without
  `--ask-diag`):
  - hidden rank -1 64/384: not sent with the prefilter rejecting 0, no intent requests 21, requests but no match 43
    (no shared term 8, under the thresholds 35, over them 0). All 21 were sent to the card model; 18 have no
    requests in the replay, 3 have some the engine did not hold at the ask.
  - decoys rank -1 77/384: not sent with the prefilter rejecting 4, no intent requests 14, requests but no match 59
    (21 / 38 / 0). The 4 have 2-4 replay requests (read at recording time) and none held; the lab cannot say whether
    `cardsLean` skipped them or they were still queued (`readForIntent` is not in `@eden/engine`'s index).
  - Reading: the hidden gap is mostly a bridge that does not match (43), then items read with no requests (21);
    `cardsLean` skips none of the 64, so a read-all trial (`intentConstraintAll`) has nothing to gain here. Decoys sit
    in the same buckets in larger numbers, so a looser bridge must be screened on decoys in pool.

### F8. D113's multi-process router was decided but never built

- **Evidence.** D113(1) (`docs/DECISIONS.md:119`). `packages/server/src/main.ts:17-31` builds one gate pool, one
  partner, one `Bun.serve`; grep finds no `reusePort`, `cluster`, `availableParallelism` or router in
  `packages/server/src`. `bun packages/engine/bench/ingest.bench.ts 40 500 shipped` 4.86-4.98 s in one process; four
  concurrent `... 10 500 shipped` 2.23-2.69 s (1.81x finder, 2.07-2.21x verifier 1 on clean pairs). These include Bun
  start-up, so they are a proxy, not server events per second.
- **Verifier 2's gaps.** (1) One SQLite source map (`$EDEN_HOME/source-map.db`, `config.ts:81`) assumes one process
  per file (`source-map.ts:72-75`); N children would contend and drop outcome batches on `SQLITE_BUSY`
  (`source-map.ts:130-136`). (2) `TenantSpend` is per process (`build.ts:84`), so N children raise each tenant's daily
  dollar cap N-fold, and the per-tenant rate limit too (`config.ts:82-83`). (3) The tenant is in the auth header but
  `userId` is in the JSON body (`http.ts:47-80`), so the router must parse bodies.
- **Fix.** D163: Stage 1 builds the router with one source map per child and divides per-tenant spend and rate caps by
  N in the same change (amends D113's "per-tenant caps become per-process").
- **Status.** Round 1, package `server-router`.

### F9. Memory per user is mostly graph objects and UTF-16 text

- **Evidence.** `bun packages/engine/bench/ingest.bench.ts --quick`: core 2,904 B/item, +graph 1,721, shipped 4,639
  released (both verifiers). Sim world (`buildWorld` seed 1, 6,892 items): 29.4% of items hold 74.2% of characters
  outside Latin-1; text 1,890 B/item as stored, UTF-8 1,090, deflate-6 365 (verifier 1). Verifier 2's heap breakdown of
  the graph: GNode objects and arrays 428 B/item, key and label strings 451, the `ids`/`slots` Maps 502, memo 215,
  `placedAt` 110. Every node's label differs from its key, so a sparse label map saves nothing.
- **Impact.** Verifier 2 estimates stage 1 as proposed at about 1.6x on the graph and 1.15x per user, not 2.5-2.9x and
  2.2x; the `ids`/`slots` Maps (502 B/item) are the bigger lever the finding left out.
- **Fix.** D169: stage 1 only, with the Maps replaced too (typed-array open-addressing from key to node id), gate at
  least 2x smaller `+graph` B/item with walks identical; if the gate fails, record the numbers and do not merge.
- **Status.** Round 1 stage 1, package `graph-soa`. Stage 2 (deflated `item.text`) deferred: 41 non-test reads of
  `item.text` include per-candidate reads on the ask path in `partner.ts` (owned by `sourceitems-removal-race`) and
  it reopens D111, so it waits for both packages and comes back as a trial.

### F10. Request-side query expansion for the last unranked facts

- **Evidence.** 64 hidden facts never rank in the top 60 with intent on (`bun run funnel --jobs 4 -- --reader stub
--intent F --packet-k 15,30,60`, verifier 1). D89's `bridgeQuery` was deleted by D112 (`docs/DECISIONS.md:96`,
  :118); it never fed the reader's pool (the reader came later, D95). Verifier 2: D89's measured history (+15 hidden of
  240 on dev with 2 ask seats, +4 bridge alone, +2 in-sample, all dev gain from 5 dev6a templates) points to about
  1.07-1.15x fewer misses, not 1.4-1.9x. D115 found widening the reader pool raised false concerns 0.0% to 4.7%.
  D99 found the reading must land before the agent answers.
- **Fix.** Stage 1 lab-only `--bridge F` replay screen, then a trial with its own Budget and a COST-MODEL.md entry.
- **Status.** Deferred to round 2: the unranked set it targets changes with F1's thresholds
  (`intent-shipped-baseline`), and F7's diagnostic (`ask-diag-coverage`) decides whether the gap is coverage or bridge.
  It also edits `hidden-funnel.ts`, owned by `ask-diag-coverage`.

### F11. Eden's path is reader model time

- **Evidence.** Final Pi run, held-out 13, seeds 41-44, eden arm (`.local/mkt/final-pi-4N/tasks.jsonl`, both
  verifiers' scripts). Hidden: wall mean 3,979 ms; Eden on path 1,372 ms (34.5%), cap 1.53x if Eden took no time.
  Control: wall 5,344 ms, on path 2,083 ms, cap 1.64x. Reader (441 calls): p50 998, p90 1,471, mean 1,088 ms; fit 702 ms
  - 2.60 ms per output token. Reader time is 94.5% (hidden) and 92.4% (control) of Eden's path, not 99% (verifier 2).
    A reader-only change caps at about 1.13-1.15x on task wall (verifier 2's arithmetic).
- **Fix.** D165, and the decomposition in COST-MODEL.md. `pi-ab-report.ts` already prints the critical path
  (`:237-262`); add a per-kind and observe/ask split instead of a new flag.
- **Status.** Round 1, package `close-docs-ceilings`.

### F12. Prompt-caching the reader's items cannot reach 1.5x

- **Evidence.** `bun run funnel --jobs 1 -- --reader stub --reader-log F` (verifier 1): 658 calls, mean 7,498 chars,
  standing prefix 0 everywhere, so the `standing` cache path (`reader.ts:285-303`) never fires; shared item prefix
  2.88% (1.72% sorted). Items are 56.0% of the whole prompt, not 90.2%. Ledger: reader input about 33-35% cached (the
  system block); output about 30% of reader cost. Verifier 2's bound: even with every ask reusing its push's prompt,
  at most 1.28x (estimate).
- **Fix.** D164; a row in COST-MODEL.md's "Where 3x is impossible" table, numbers labelled measured or estimate.
- **Status.** Round 1, package `close-docs-ceilings`.

### F13. Moving the push off the agent's start loses most useful pushes

- **Evidence.** Eden arm, final Pi run: hidden tasks with a useful push end in one request 66 times, two requests 9
  times; control 10 and 10 (verifier 1's join). `readerPushWaitMs: 60_000` (`config.ts:588`), observe races it
  (`partner.ts:683-688`), capped in practice by the 3,000 ms `waitMs`. D118's off-path variant measured hidden 81.3% to
  75.0%. Request count is partly caused by the push, so "88% never read" overstates the loss; D118 is the measurement
  that holds.
- **Fix.** D166, a one-line cross-reference in COST-MODEL.md.
- **Status.** Round 1, package `close-docs-ceilings`.

### F14. The ask's poll and the reader: closing O9's item

- **Evidence.** `eden.sync.freshen` spans inside asks: mean 13-17.5 ms, p90 0.1 ms, max 797 ms (verifiers' scripts).
  The reader's pool comes from the `searchLive` result (`partner.ts:1253`, `:1303-1309`), so it cannot start earlier
  without reading a different pool. Upper bound 1.13-1.14x on ask batches, about 1.01x on task wall.
- **Fix.** D167; mark `lat-ask-reader-overlap-poll` closed in the 2026-11-05 audit's open-items table (O9). The other
  two O9 items stay open.
- **Status.** Round 1, package `close-docs-ceilings`.

## Round 1

### Decisions taken in planning

The owner delegated judgement calls. Each is a row in docs/DECISIONS.md with its evidence: D158 (the lab screens the
shipped default with intent replayed), D159 (promote the looser intent thresholds, conditional on a Pi pair), D160
(how `sourceItems` respects a removal that lands during redaction), D161 (defer six end-to-end files in
`test:changed`), D162 (the ask's lexical cap stays at 12), D163 (router stage 1 splits per-tenant caps and source
maps), D164-D167 (four closed ceilings), D168 (the closed-class imperative rule is rejected), D169 (graph
struct-of-arrays gate). Packages do not edit docs/DECISIONS.md; each reports its measured outcome in its commit
message and owned docs, and the integration step appends the outcome to the row.

### Work packages

No two packages share a file. Paid spend is ledger-metered with the flags above; round 1's estimated paid total is
about $1.3 (estimate: F1/F2 package about $1.2, everything else $0).

| Package                    | Findings           | Files it owns                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent-shipped-baseline`  | F1, F2             | `packages/sim/src/lab/funnel.ts`, `packages/engine/src/config.ts`, `packages/engine/src/intent.test.ts`, new `packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz`, `docs/LAB.md`, `CLAUDE.md`, `packages/sim/src/lab/CLAUDE.md`, `docs/research/edge-intent.md` |
| `sourceitems-removal-race` | F3                 | `packages/engine/src/partner.ts`, `packages/engine/src/freshness.test.ts`, `packages/engine/CLAUDE.md`                                                                                                                                                                          |
| `test-changed-defer-e2e`   | F4                 | `scripts/test-select.ts`, `scripts/test-select.test.ts`, `docs/TESTING.md`                                                                                                                                                                                                      |
| `ask-diag-coverage`        | F7 stage 1         | `packages/sim/src/lab/hidden-funnel.ts`                                                                                                                                                                                                                                         |
| `server-router`            | F8                 | new `packages/server/src/router.ts`, new `packages/server/src/router.test.ts`, new `packages/server/bench/router.bench.ts`, `packages/server/src/config.ts`, `packages/server/src/build.ts`, `packages/server/CLAUDE.md`, `docs/ARCHITECTURE.md`                                |
| `graph-soa`                | F9 stage 1         | `packages/engine/src/kg.ts`, `packages/engine/src/kg.test.ts`, `packages/engine/bench/ingest.bench.ts`, new `docs/research/graph-soa.md`                                                                                                                                        |
| `close-docs-ceilings`      | F11, F12, F13, F14 | `docs/COST-MODEL.md`, `docs/audits/2026-11-05-deep-audit.md`, `packages/sim/src/lab/pi-ab-report.ts`                                                                                                                                                                            |

### Deferred to round 2

| Finding                                    | Waits for                                      | Why                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| F5 `devloop-ask-diag-forces-one-process`   | `intent-shipped-baseline`, `ask-diag-coverage` | Edits `funnel.ts` and `hidden-funnel.ts`, which those packages own                                                   |
| F6 `quality-push-skipped-imperative-list`  | `intent-shipped-baseline`                      | Must be screened on the intent-on cache and thresholds that package produces; its trial switch edits `config.ts`     |
| F10 `moonshot-ask-query-expansion-ceiling` | `intent-shipped-baseline`, `ask-diag-coverage` | Its target set changes with the new thresholds; F7's diagnostic decides coverage vs bridge; edits `hidden-funnel.ts` |
| F9 stage 2 (deflated item text)            | `graph-soa`, `sourceitems-removal-race`        | Reads of `item.text` on the ask path are in `partner.ts`; the bench is owned by `graph-soa`; reopens D111 as a trial |

## Round 2

Planned on 2026-11-06 from `audit/2026-11-06-integration` bb8ca755f (round 1 merged). Fifteen findings survived two
independent verifiers each. The spend ledger (`.local/mkt/ledger.jsonl`) sums to $12.87 over 50,337 rows (a `bun -e`
sum run while writing this section), so about $4.8 is left under the $18 cap and its $0.3 headroom (estimate: 18 -
12.87 - 0.3). Round 2's packages are estimated at about $0.7 of paid spend; the deferred live gates at about $1.8.

### Round 2 in plain words

- **Intent pays for reads that buy nothing.** With intent on, 84% of what the card model reads is items that fail the
  card filter and are read only to guess which requests they answer. Skipping those reads keeps every bit of intent's
  measured gain on train and held-out suites while sending 6.4x fewer items and 2.7x fewer calls to the card model
  (measured). Estimated effect: Eden's own model cost per task about 1.55x lower. It enters as a trial (D170) because
  the screens cannot see the one case those reads exist for.
- **A server search is slow on big knowledge bases.** The built-in static source re-reads every document on every
  search: about 250-300 ms of blocked CPU per search at 40,000 documents. Building each document's word set once makes
  search 7-25x faster and cut CPU per event 2.5x in a server-shaped run (measured).
- **The live test of intent mostly ran without intent.** The held-out 13 Pi runs replay cards with no intent file, so
  about two thirds of items had no intent (estimate). D159 was rejected on that run, and its cost rise turns out to be
  the two arms racing for one prompt cache (D171), so D159 is reopened for a fair re-run (deferred: it needs this
  round's intent file and cost report first).
- **Two correctness bugs.** A delete, re-push, delete sequence inside ten minutes can still undo the second delete
  (D160 was incomplete); and a router child that hangs on restart is never retried, so its users get 503 until a
  human acts.
- **Lab hygiene.** The checked-in intent file misses a quarter of the planted hidden facts, the diagnostic counts
  those as "no intent requests", and the precision guard counts decoys the reader never flagged. These are fixed as
  reporting changes; the gates themselves are unchanged (D173).
- **Developer loop.** Round 1's graph test and router tests made the engine and server test loops slower; both are
  trimmed in the fast loop and kept whole in `bun run check`.
- **Recorded so nobody chases it again.** Ranking an agent-worded ask on its question plus the session's request does
  not help with a real reader; the stub got the sign wrong (D174).

### Round 2 findings, ranked by value

Severity first, then effort; within a tier, by measured impact.

| #   | Finding                                        | Severity | Effort | Status                                                                          |
| --- | ---------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------- |
| F15 | `cost-intent-request-only-reads-buy-nothing`   | high     | S      | Round 2 stage 1, package `intent-constraint-only`; D170; stage 2 deferred       |
| F16 | `scale-static-source-retokenizes-per-search`   | medium   | S      | Round 2, package `static-source-index`; D175                                    |
| F17 | `correctness-d160-second-removal-undone`       | medium   | S      | Round 2, package `removal-sequence`; D176                                       |
| F18 | `quality-pi-heldout13-intent-inert`            | medium   | S      | Round 2 steps 1-3, package `intent-replay-coverage`; step 4 deferred            |
| F19 | `correctness-router-restart-hang-no-timeout`   | medium   | S      | Round 2, package `router-hardening`; D172                                       |
| F20 | `quality-d159-cost-gate-prompt-cache-artefact` | medium   | S      | Round 2 stage 1, package `pi-cost-cache-neutral`; D171; stage 2 deferred        |
| F21 | `quality-intent-replay-misses-planted-facts`   | medium   | S      | Round 2, packages `intent-replay-coverage` and `ask-diag-precision-split`; D173 |
| F22 | `measure-decoys-surfaced-mostly-unflagged`     | medium   | S      | Round 2, package `ask-diag-precision-split`; D173                               |
| F23 | `devloop-router-gate-measures-static-source`   | medium   | S      | Round 2 bench, package `router-hardening`; D172; the gate run deferred          |
| F24 | `devloop-kg-differential-test-undoes-d161`     | medium   | S      | Round 2, package `kg-oracle-seeds`; D176                                        |
| F25 | `devloop-retrieval-screen-set-subset-replay`   | medium   | M      | Deferred (waits for `intent-replay-coverage` and `ask-diag-precision-split`)    |
| F26 | `docs-d159-row-says-promoted`                  | low      | S      | Fixed in planning (D159's result appended; this report's F1 corrected)          |
| F27 | `devloop-router-test-doubles-server-loop`      | low      | S      | Round 2, package `router-hardening`; D172                                       |
| F28 | `lab-intentplace-cut-differs-from-engine`      | low      | S      | Round 2, package `ask-diag-precision-split`; D173                               |
| F29 | `quality-o7-ask-request-union-rejected`        | low      | S      | Closed by D174; a LAB.md caution in `ask-diag-precision-split`                  |

### F15. Intent's request-only reads add nothing to the reader's pool

- **Evidence.** With `intent` on, an item the card prefilter rejects is still read for its requests
  (`packages/engine/src/cards.ts:845-856`, `readForIntent` at `:205-213`; `cardsLean` trims only automated or
  30-day-old items, `config.ts:574-576`). docs/research/new-minus-intent.md:61-62 skipped the constraint-only arm as
  "in effect intent off". Finder and both verifiers, exact matches, `bun run funnel --jobs 4 -- --intent <gunzipped
intent-v2>`, train1-6 seeds 41-42, $0: `cards use` sent 13,604 items (11,491 request-only, 84.5%) in 822 calls
  becomes 2,113 in 300; pool hidden/decoys 257/240 becomes 257/235; TOTAL 243/228 becomes 245/225. By task, 8 hidden
  lost and 8 gained in the pool; 9 decoys lost, 4 gained. Held-out 10-11 (`--blind`): sent 4,514 to 650, pool 50/39
  to 52/40. Control `--set '{"intent":false}'`: pool 230/229 at the same 2,113 items and 300 calls. Paid reader screen
  (ledger run `audit-r2-cost-intent-noonly`, 295 calls, $0.0868; verified in the ledger, not re-run): hidden 278 vs
  273, paired +1.30 points (CI -1.15..+3.75), decoys +0.00; it shares 359 readings with the base cache. Without `--
--intent F` the funnel prints "[intent inert: no replay]"; a rerun must pass the file.
- **Impact.** 6.44x fewer items and 2.74x fewer calls for the cards role (measured). Role cost about 4.5x lower and
  Eden's model cost per 1k Pi tasks $0.845 to $0.544 (1.55x), all-in $1.168 to $0.867 (estimates from measured items
  and COST-MODEL.md:357-358). Blind spot: planted facts are constraint-worded by design, so no screen yet tests an
  unworded item that bears on a request.
- **Fix.** Trial switch `intentConstraintOnly` (D170, trials row); rejected items go to `keep(..., card: null)` and
  count in a new `intentSkipped` stat; unit tests; $0 screens; a fresh-cache paid funnel pair; an unworded-bearing eval
  or sim case; a COST-MODEL.md line; correct new-minus-intent.md:61-62. Stage 2 (promotion and deleting `cardsLean`)
  waits for the Pi gate.
- **Status.** Round 2 stage 1, package `intent-constraint-only`. Stage 2 deferred.

### F16. StaticSource re-tokenizes every document on every search

- **Evidence.** `packages/sources/src/static-source.ts:46-56` builds `new Set(words(title + text))` for every item on
  every search; `fetch` is a linear `find` (`:63`). Served by `packages/server/src/connectors.ts:55` and, one per user
  scope, `packages/server/src/user-sources.ts:364`; also `packages/eval/src/run.ts:266`. Verifier 2's micro-bench
  (limit 10, 40 queries): 2.78 to 0.11 ms at 400 docs, 23.12 to 1.51 at 4,000, 253.47 to 36.86 at 40,000, same refs on
  every query; build 6.1 / 28.8 / 275 ms. In-process `buildPartner` (one 400-doc source, 100 users x 5 events): CPU per
  event 14.67-14.86 to 5.94-5.96 ms (2.5x), 74-79 to 239 events/s. Term sets add about 3,372 B per doc. Verifier 1
  measured 9.68 / 75.92 / 989 ms per search with longer docs. The finder's router.bench and CPU-profile figures were
  run on a non-main tree and were not reproduced.
- **Impact.** About 0.25-1 s of blocked CPU per search at 40,000 docs (measured, doc-length dependent); several
  searches per event, so every user on the process stalls.
- **Fix.** D175: lazy term sets on first search, a ref map for `fetch`, a same-refs property test, a bench file; an
  inverted index only if it beats the term sets 1.5x at 40k docs with no more memory.
- **Status.** Round 2, package `static-source-index`.

### F17. A second removal during the redaction await is still undone

- **Evidence.** `packages/engine/src/partner.ts:1770-1779` keeps `goneBefore.has(id) || !isHeldGone(...)`;
  `TenantHolds.hold` (`packages/engine/src/cache.ts:356-364`) only rewrites `until`. Repro (three agents, both gate
  modes): `sourceRemoved(q1)`; advance 1 min; `p = sourceItems([q1])` unawaited; `sourceRemoved(q1)`; `await p` prints
  `stored 1 cached true heldGone false`. A verifier's per-hold sequence prototype passed freshness.test.ts 22/22 and
  cache.test.ts 31/31.
- **Impact.** Deleted content stays cached and deliverable, its hold lifted, until TTL or sweep; the shape of a
  delete, undo, delete forwarded by an integrator inside 10 minutes. Breaks D126's "a removal that comes after wins".
- **Fix.** D176: a counter stored with each hold (inside the existing hold caps), snapshot before the await, drop on
  change; the repro as a third D160 case in both modes.
- **Status.** Round 2, package `removal-sequence`.

### F18. The held-out 13 Pi runs replay cards with intent mostly inert

- **Evidence.** `packages/sim/src/lab/pi-ab.ts:204-208` and `hermes-ab.ts:157-159`: `--intent` defaults to empty.
  `INTENT_COVERS` (`funnel.ts:151-155`) covers train and held-out 10-11 only. `cards-disk.ts:190` appends only `{h,c}`,
  so live requests are lost. The final-live recipe (docs/research/final-live-2026-11-05.md:190-200) passes no
  `--intent`; new-card files final-pi-41..44 hold 486/500/511/506 lines with no `"r"`. Dry runs reconciled by both
  verifiers: `cards-enrich.ts --funnel heldout13 --intent --dry` gives 124 to enrich (13 calls) for seeds 41-42 and
  301 (31 calls) for 41-44; intent-v2 already covers about 96% of held-out 13 items (1,477 of 1,541 for seed 41)
  because the background world is shared by seed. The finder's 616 calls and "about 90% inert" did not reproduce;
  verifier 1's estimate is about 32% carded live, 68% inert per seed.
- **Impact.** Every held-out 13 Pi figure, including D159's rejection, measured the default with intent mostly off.
  Topping up costs about $0.03 (estimate: 301 x $0.0000923).
- **Fix.** Enrich the missing held-out 13 items into intent-v2 and extend `INTENT_COVERS`; pi-ab and hermes-ab load the
  covering file by default (`--intent none` opts out) and print `intent: replayed n of m items`; `DiskCardMaker`
  appends `{h,c,r}`. Step 4 (re-run D159's pair) is deferred.
- **Status.** Round 2 steps 1-3, package `intent-replay-coverage`; step 4 deferred.

### F19. A restarted router child that hangs is never retried

- **Evidence.** `startTimeoutMs` bounds only the first `Promise.race` (`packages/server/src/router.ts:308-316`);
  restarts come only from `proc.exited` (`:266-283`). Both verifiers' repro (child exits after 300 ms, second start
  never listens; `processes:1, restartMs:50, startTimeoutMs:1000`): after 3 s `spawns 2 up false`, `/healthz` 503. With
  a per-spawn SIGKILL deadline: 4 spawns in 3 s, exit 137 each, backoff 50/100/200 ms; router.test.ts 16/16.
- **Impact.** 1/N of users offline until a human restarts the router (trial deployments; `EDEN_PROCESSES` defaults to
  1).
- **Fix.** Per-spawn deadline, cleared on ready or exit; reconcile with the first-start race so a failed first start
  still rejects with no orphans; a test asserting the spawn count grows.
- **Status.** Round 2, package `router-hardening`.

### F20. D159's cost rise came from the arms racing for one prompt cache

- **Evidence.** pi-41/pi-42, 128 task pairs, both verifiers (bootstrap): Eden's own delta +$0.000014/task (CI
  -0.000025..+0.000053). On 47 identical-ask pairs agent input is flat (+2.7 tokens) but cost +$0.0000417/task (CI
  +0.0000174..+0.0000660), all from cached -403 and cache-write +405 tokens; cache-neutral agent+Eden -0.0002 $/1k (CI
  -0.020..+0.018). Mechanism: concurrent condition streams with the same system prompt (`pi-ab.ts:1133-1137`, `:800`,
  `cacheRetention: "short"` at `:850`); the baseline got the first-request hit 29 times, the variant 5. The paired
  billed $/1k is computed at `pi-ab-report.ts:300-309` (the finding's `:396` is the Eden section). `reprice.ts` has no
  cache-write price (`:15`, `:22-48`, `:55-61`).
- **Impact.** A bias of about $0.04 per 1k tasks against the condition listed second in every same-prefix Pi pair,
  the size of a typical promotion delta.
- **Fix.** D171: cache-neutral agent cost and Eden-only cost beside billed in `pi-ab-report.ts`, with a cache-write
  price in `reprice.ts`; re-run the report on pi-41/pi-42.
- **Status.** Round 2 stage 1, package `pi-cost-cache-neutral`. Stage 2 (re-decide D159) deferred.

### F21. The intent replay has no line for a quarter of planted hidden facts

- **Evidence.** Both verifiers, $0, with `?? 0` changed to `?? -1` at `packages/sim/src/lab/hidden-funnel.ts:750`: 98
  of 384 hidden and 43 of 384 decoys have no line (seed 41: 38, seed 42: 60; train2 29, train3 24, train1 23, train5
  11, train6 11, train4 0); "replayed requests for 13440 of 13604 items asked"; 18 of the 64 rank -1 hidden are replay
  misses; the file holds only 20 empty-request lines. Surfaced: 67/98 without a line against 206/286 with. Top-ups
  (finder, paid, not re-run): pool +3 hidden, +2 decoys, CIs include 0. `cards-enrich --dry` for train 41-42: 102 to
  enrich (11 calls).
- **Impact.** About neutral on totals, but it biases every intent and bridge screen unevenly by seed and suite and
  mis-steers O7's bucket split. About $0.03 to top up (estimate: 341 items, 36 calls).
- **Fix.** Top up intent-v2 for train 41-44 and held-out 10-11 and the intent-on reader cache
  (`intent-replay-coverage`); report a missing line as "not in replay" and print planted coverage
  (`ask-diag-precision-split`).
- **Status.** Round 2, split across the two packages by file.

### F22. The precision guard counts decoys the reader never flagged

- **Evidence.** Both verifiers, exact, committed intent-on cache (`bun run funnel --jobs 4 --allow-misses --json out
-- --reader replay --reader-model claude-haiku-5-5 --reader-cache <it>`): 137 decoys surfaced, 23 flagged, 68 rule
  path (grounded-conflict 28, fallback 19, sources 9, anticipated 4, grounded-card 3, grounded-clash 2, cache 2, graph
  1), 46 listed-only (18 actually read, 3 gated, 25 skipped). Fallback surfaces 19 decoys against 8 hidden. Pool
  decoys 240, flagged 23. `partner.ts:1670` lists chosen items not explicitly rejected.
- **Impact.** The "decoys must not rise" guards mix three different things; rule-path decoys are the real precision
  lever.
- **Fix.** D173: report the split; gates unchanged.
- **Status.** Round 2, package `ask-diag-precision-split`.

### F23. D163's router gate mostly measures StaticSource and swings across 1.5x

- **Evidence.** `router.bench.ts:58-68` serves 400 static docs; warm-up is one event per user (`:149-162`). Ratios on
  the same command: 1.64 and 1.32 unmodified, 1.78 and 2.8 with term sets precomputed (verifier 1); 1.64, 3.70, 1.58
  (verifier 2). Verifier 2 found warm-up is not the main noise: processes sit in a slow (about 400-470 ev/s) or fast
  (about 1,000) mode, 2 s steps let one p99 spike drop a step, and the load generator shares the cores.
- **Impact.** The `EDEN_PROCESSES` default rests on a single-run gate that flips.
- **Fix.** D172: median of at least 3 repetitions, lowest at least 1.2x, longer steps, alternating arms, documented
  source; the deciding run happens on the merged tree after `static-source-index`, before and after both reported.
- **Status.** Round 2 bench changes, package `router-hardening`; the deciding run deferred.
  Round 3: the gate on simulated users (`packages/sim/src/lab/router-sim.bench.ts`, per-user SimSource connectors at
  time scale 1, sync on, median of 3): router over 4 children 5.96x one process on REALISTIC (lowest 5.94x), 3.36x on
  the market `hosted` profile (lowest 3.20x); memory per child and the figures in D172's outcome. The advantage holds,
  so no new decision; the StaticSource deciding run stays D172's.

### F24. The graph's 200-seed differential test slows the engine loop

- **Evidence.** `packages/engine/src/kg.test.ts:1004-1005` (200 seeds against `PreviousGraph` at `:472`): the file
  takes 5.97-6.91 s (115,841 expects) against 0.27-0.52 s on main; 25 seeds 1.87-2.34 s. The engine-edit `test:changed`
  gain is load-dependent: 15.58 vs 9.32 s on a quiet pair (verifier 1), median about 1.18x over 9 pairs at load 6-14
  (verifier 2). Missing from TESTING.md's slowest-files table; `test-select.ts:42` still cites D161's figures.
- **Impact.** Several seconds per engine edit; not a 1.5x lever on a busy box.
- **Fix.** D176: 25 seeds in `test:changed` through a non-`EDEN_` variable (test-preload clears `EDEN_*`), 200 in
  check and test:pkg; TESTING.md row.
- **Status.** Round 2, package `kg-oracle-seeds`.

### F25. No $0 screen for an O7 retrieval change

- **Evidence.** D159's arm against the intent-on cache: `{"replayed":74,"missed":1118}` (both verifiers); the default
  replays 645/5. `SubsetReplay` needs the same order (`reader-disk.ts:149-160`). Against a stub wide log, the D159 arm
  is 239 ordered, 411 set-only, 6 uncovered of 656 (verifier 1, own script).
- **Impact.** About $0.19 and 7 min per arm today (measured recording: 652 calls, $0.18548, 418 s).
- **Fix.** An unordered subset replay labelled APPROXIMATE, gated on per-call agreement and on one changed arm's delta
  against a real reading; it departs from D117 and needs its own decision.
- **Status.** Deferred: see below. Round 3: a retrieval screen without the unordered replay (`retrieval-screen.ts`,
  docs/LAB.md 1d): train1–6 seed 41, where every replay cache answers with 0 misses; 0.6x the funnel's wall time,
  its rows are the funnel's (same worlds, a determinism check); as a predictor, its totals' signs matched the
  funnel's on the three past changes that moved 32+ screen tasks and not on minus-graph (6).
  The unordered subset replay and its decision stay open.

### F26. D159's row said the looser thresholds join the default

- **Evidence.** DECISIONS.md D159 had no result; this report's summary and F1 said "promotes"; `config.ts:576-578`
  ships 6/0.35/2; edge-intent.md:135 records the outcome.
- **Fix.** Done in planning: D159 now ends with its result and the two caveats; F1 and the summary corrected.
- **Status.** Fixed (this commit).

### F27. router.test.ts doubles the server package's test loop

- **Evidence.** `bun run test:pkg server`: 3.17-3.48 s (100 tests) against 1.45-1.47 s on main (84). The routing tests
  already share one router (`router.test.ts:148-171`); the burst test needs its own env; the N 2->3->2 test alone is
  1.09-1.57 s. Verifier 2's floor for one file is about 1.8 s; splitting into two files lets `--parallel` overlap them
  (estimate 1.3-1.6 s).
- **Fix.** D172: split into `router.test.ts` and `router-processes.test.ts`, same 16 tests and expect count.
- **Status.** Round 2, package `router-hardening`.

### F28. `--ask-diag`'s intent place does not model the engine's cut

- **Evidence.** The engine takes at most `intentHits` accepted raw hits from a BM25 top k*2, then thresholds
  (`partner.ts:4474-4486`, `cards.ts:1091-1113`); the diag calls `intentFinds` with k = `intentSize` at `clock`
  (`hidden-funnel.ts:745-766`) and ranks among passing hits. Today "over thresholds 0" for hidden and decoys, so no
  bucket is wrong yet; one passing row already sits at rank 6.
- **Fix.** Call with k = `intentHits` and the ask's arrival, threshold after, add a "passes but past the cut" bucket;
  an ask-coverage.test.ts case.
- **Status.** Round 2, package `ask-diag-precision-split`.

### F29. The ask plus request union is not a lever

- **Evidence.** See D174.
- **Fix.** No product change; a LAB.md caution that ask-cue changes are screened paid.
- **Status.** Closed by D174.

### Round 2 decisions

Taken in planning, each a row in docs/DECISIONS.md with its evidence: D159's result appended (not promoted, and
reopened on a fair Pi pair); D170 (constraint-only intent is a trial, with promotion gates); D171 (Pi cost gates read
cache-neutral agent cost plus Eden cost, billed printed beside); D172 (router gate on medians, per-spawn deadline,
test split); D173 (diagnostic split is reporting only, gates unchanged); D174 (the ask union is rejected, ask-cue
changes screened paid); D175 (StaticSource term sets built lazily, not in the constructor); D176 (oracle seeds in
the fast loop; removal sequence numbers). As in round 1, no package edits docs/DECISIONS.md (D170's trials row is
already written). Each package reports its measured outcome in its commit message and owned docs; the integration step
appends outcomes to the rows.

### Round 2 work packages

No two packages share a file. Paid spend is ledger-metered with `--spend-ledger .local/mkt/ledger.jsonl --spend-cap 18
--spend-headroom 0.3`, Anthropic `claude-haiku-5-5` only.

| Package                    | Findings                 | Files it owns                                                                                                                                                                                                                                                                                                                                                                    | Paid (estimate) |
| -------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `intent-constraint-only`   | F15 stage 1              | `packages/engine/src/cards.ts`, `packages/engine/src/cards.test.ts`, `packages/engine/src/config.ts`, `packages/engine/src/config-check.ts`, `packages/engine/src/config-check.test.ts`, `docs/COST-MODEL.md`, `docs/research/new-minus-intent.md`                                                                                                                               | about $0.40     |
| `intent-replay-coverage`   | F18 1-3, F21 (1)         | `packages/sim/lab/distilled/intent-v2.jsonl.gz`, `packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz`, `packages/sim/src/lab/funnel.ts`, `packages/sim/src/lab/pi-ab.ts`, `packages/sim/src/lab/hermes-ab.ts`, `packages/sim/src/lab/cards-disk.ts`, `packages/sim/src/lab/cards-disk.test.ts`, `packages/sim/src/lab/CLAUDE.md`, `docs/research/edge-intent.md` | about $0.25     |
| `pi-cost-cache-neutral`    | F20 stage 1              | `packages/sim/src/lab/pi-ab-report.ts`, `packages/sim/src/lab/reprice.ts`, `packages/sim/src/lab/reprice.test.ts`, new `docs/research/pi-cache-neutral-cost.md`                                                                                                                                                                                                                  | $0              |
| `removal-sequence`         | F17                      | `packages/engine/src/partner.ts`, `packages/engine/src/cache.ts`, `packages/engine/src/cache.test.ts`, `packages/engine/src/freshness.test.ts`, `packages/engine/CLAUDE.md`                                                                                                                                                                                                      | $0              |
| `router-hardening`         | F19, F23, F27            | `packages/server/src/router.ts`, `packages/server/src/router.test.ts`, new `packages/server/src/router-processes.test.ts`, `packages/server/bench/router.bench.ts`, `packages/server/CLAUDE.md`                                                                                                                                                                                  | $0              |
| `static-source-index`      | F16                      | `packages/sources/src/static-source.ts`, new `packages/sources/src/static-source.test.ts`, new `packages/sources/bench/static-source.bench.ts`, `packages/sources/CLAUDE.md`                                                                                                                                                                                                     | $0              |
| `kg-oracle-seeds`          | F24                      | `packages/engine/src/kg.test.ts`, `scripts/test-select.ts`, `scripts/test-select.test.ts`, `docs/TESTING.md`                                                                                                                                                                                                                                                                     | $0              |
| `ask-diag-precision-split` | F21 (2-3), F22, F28, F29 | `packages/sim/src/lab/hidden-funnel.ts`, `packages/sim/src/lab/ask-coverage.ts`, `packages/sim/src/lab/ask-coverage.test.ts`, `docs/LAB.md`                                                                                                                                                                                                                                      | $0              |

Notes on the split:

- `intent-replay-coverage` and `ask-diag-precision-split` both serve F21 but own different files: the data and
  `funnel.ts` in the first, the diagnostic (`hidden-funnel.ts`, `ask-coverage.ts`) in the second. The "not in replay"
  bucket reads 98/43 before the top-up and should read 0 once both merge; that check runs at integration.
- `intent-constraint-only` measures on today's intent-v2; both arms share it, so the pair stays valid after the top-up.
  The integration step re-runs its $0 screen on the merged tree.
- `intent-constraint-only`'s new `intentSkipped` stat prints with no sim change: `hidden-funnel.ts:1207` sums every
  key of the card stats into the `cards use` line.

### Round 2 deferred

| Finding                                            | Waits for                                                                   | Why                                                                                                                                                                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F15 stage 2 (Pi gate, promote, delete `cardsLean`) | `intent-constraint-only`, `intent-replay-coverage`, `pi-cost-cache-neutral` | The Pi held-out 13 pair needs the held-out 13 intent file and D171's cost report (about $0.26); deletion follows only a passed gate (D112)                                                                                          |
| F18 step 4 and F20 stage 2 (re-decide D159 on Pi)  | `intent-replay-coverage`, `pi-cost-cache-neutral`                           | A fair pair needs intent replayed and cache-neutral cost; 4 seeds about $1.04 (estimate)                                                                                                                                            |
| F23's deciding run (the `EDEN_PROCESSES` default)  | `router-hardening`, `static-source-index`                                   | D172 decides on the merged tree, before and after the StaticSource fix, at $0                                                                                                                                                       |
| F25 `devloop-retrieval-screen-set-subset-replay`   | `intent-replay-coverage`, `ask-diag-precision-split`                        | Its one-time wide recording (about $0.45) would go stale when the intent top-up changes reader prompts; `--reader-subset` is parsed in `hidden-funnel.ts:165`, which the diag package owns; it also needs a decision departing D117 |
| Round 1's F5, F6, F10                              | (carried over)                                                              | Not re-verified in round 2's finding set; they stay open as round 1 recorded them                                                                                                                                                   |

## Closing

Written on 2026-11-06 from `audit/2026-11-06-integration` 4503fabb6 (rounds 1 and 2 merged). The closing step's
planning runs and the final packages (`intent-closeout`, `router-default`, `funnel-parallel-diag`) settled every
deferred item; each now has a row in docs/DECISIONS.md, D177-D182, or a merged package. The round 2 outcomes are
appended to D158, D163, D170-D173, D175 and D176 (marked "Outcome"; D159 marked "Re-decided by D179"). The spend
ledger (`.local/mkt/ledger.jsonl`) held $13.78 after planning; a `bun -e` sum of its `costUsd` while writing this
section, after the final packages' paid runs, gave $14.48 over 56,382 rows, so about $3.2 is left under the $18 cap
and its $0.3 headroom (estimate: 18 - 14.48 - 0.3).

### Every deferred item

| Item                                                    | Where it ends                                                                                                     | Row                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------ |
| F5 `devloop-ask-diag-forces-one-process` (round 1)      | Fixed by package `funnel-parallel-diag` (commit f086b5605): diagnostic runs use every core, parts merged in order | none (lab tooling)       |
| F6 `quality-push-skipped-imperative-list` (round 1)     | Waits for D179; the verb-recognising trial also covers the 2026-11-05 audit's `quality-push-skipped-top15`        | D182, then D186 (D168)   |
| F10 `moonshot-ask-query-expansion-ceiling` (round 1)    | Waits for D179: it screens on the final intent thresholds                                                         | D182, then D184          |
| F9 stage 2, deflated `item.text` (round 1)              | Not built: about 1.42x per item (estimate) for CPU on every ask read                                              | D181 (D111 stands)       |
| F15 stage 2, the `intentConstraintOnly` gates (round 2) | Failed the fresh-cache paid pair (hidden 286 to 281, decoys 140 to 144); switch deleted                           | D177 (ends D170)         |
| F18 step 4 and F20 stage 2, re-decide D159 on Pi        | Pi held-out 13 pair, intent replayed, D171's cost; promoted 0.2/1/12                                              | D179                     |
| F23's deciding run, the `EDEN_PROCESSES` default        | Passed D172's rule before and after the StaticSource fix; default is the core count                               | D178 (ends D163's trial) |
| F25 `devloop-retrieval-screen-set-subset-replay`        | Waits for D179: its wide recording goes stale when the thresholds change                                          | D182, then D185          |
| 2026-11-05 O5 `ask-deadline.test.ts` timing             | 25 of 25 passes; bound kept (D140)                                                                                | D180 (a)                 |
| 2026-11-05 O8, three dev-loop items                     | Funnel start-up is the engine's own backfill; ingest bench clock is correct; no hidden test directories           | D180 (b)-(d)             |
| 2026-11-05 O9, two remaining items                      | Label retention fixed by D169's copies; poll tuning below the 1.5x bar and unpaid                                 | D180 (e)-(f)             |
| 2026-11-05 O7, the unranked quarter                     | Superseded by D158 and D162; the remaining bridge is F10                                                          | D182, then D184          |

### The $0 preset screen on the merged tree

Every lab preset (D112: `default` and `default minus <part>`) at $0 on 4503fabb6, planning run: `bun run funnel`,
stub reader, train1-6 seeds 41-42, intent replayed. The pool proxy is the reader pool's hidden/decoys of 384.

| Preset                                      | Reader pool (hidden/decoys) |
| ------------------------------------------- | --------------------------- |
| `default`                                   | 262/246                     |
| minus `probes`                              | 252/234                     |
| minus `grounds`                             | 260/247                     |
| minus `fallback`, `compaction`, `freshness` | identical to `default`      |
| minus `graph`                               | 261/244                     |
| minus `anticipate`                          | 262/245                     |
| minus `sync`                                | 209/187                     |
| minus `askVerdicts`                         | 255/236                     |
| minus `cards`                               | 232/225                     |
| minus `intent`                              | 230/229                     |

No part's removal beats the default on the pool proxy: every removal but four loses hidden facts: the three
identical ones change nothing, and minus `anticipate` keeps hidden with one decoy fewer, inside the ±3-task noise
(D153 already kept anticipation). Nothing is promoted or deleted from this screen. The screen predates D179's
thresholds; the post-D179 screen, with the replayed paid reader, is in "Closing pass 3" below.

## Closing pass 3

Written on 2026-11-06 from `audit/2026-11-06-integration` 397c78b00 (every closing package merged, D179's
thresholds in the default). Every number here comes from a run in this pass on 4 shared cores, at $0.

### The post-D179 preset screen with the replayed paid reader

Command (LAB.md recipe 2a plus `--preset P`; train1-6, seeds 41-42, cards and intent replayed):

```bash
gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz > R
bun packages/sim/src/lab/funnel.ts --preset P --jobs 4 --allow-misses -- --reader replay \
  --reader-model claude-haiku-5-5 --reader-cache R
```

The cache holds the default's reading, so a preset that changes the reader's prompts misses it. Misses are answered
without the reader (fail open), so only the 0-miss rows are exact; the others only approximate a paid reading.

| Preset                                                                  | Surfaced (hidden/decoys of 384) | Reader pool (hidden/decoys) | Replayed / missed |
| ----------------------------------------------------------------------- | ------------------------------- | --------------------------- | ----------------- |
| `default`                                                               | 311/137                         | 278/254                     | 651 / 0           |
| minus `probes`                                                          | 282/188                         | 274/245                     | 301 / 662         |
| minus `grounds`                                                         | 309/147                         | 276/255                     | 598 / 106         |
| minus `fallback`                                                        | 311/133                         | 278/254                     | 651 / 0           |
| minus `compaction`, `judge`, `freshness`, `slowPathQueue`, `probeGrace` | identical to `default`          | 278/254                     | 651 / 0           |
| minus `graph`                                                           | 305/154                         | 279/253                     | 516 / 264         |
| minus `anticipate`                                                      | 309/144                         | 278/253                     | 605 / 77          |
| minus `sync`                                                            | 229/203                         | 213/189                     | 0 / 1,242         |
| minus `askVerdicts`                                                     | 299/227                         | 275/248                     | 207 / 862         |
| minus `cards`                                                           | 216/207                         | 232/225                     | 37 / 1,156        |
| minus `intent`                                                          | 226/156                         | 230/229                     | 419 / 449         |
| minus `reader`                                                          | 281/256                         | 0/0 (no reader)             | 0 / 0             |

Only minus `fallback` departs from the default among the exact rows: 4 decoys fewer, which `--baseline` shows are two
templates times two seeds. D183 keeps the part (no $0 arm moves, and `bun run eval` loses precision and recall
without it). Every other removal loses hidden facts or adds decoys, or changes nothing.

### Checks run in this pass

- `bun run check` on the final tree: format, types and 1,760 tests pass, 0 fail, over 143 files.
- `bun run eval`: precision 0.8276, recall 0.48, falseFireRate 0, unchanged.
- `bun test packages/server/src/router.test.ts packages/engine/src/ask-deadline.test.ts`, 3 runs: 18 pass, 0 fail
  each time.
- `git branch --no-merged HEAD --list 'audit/2026-11-06-*'` prints nothing: no audit branch is left unmerged.
- `git diff a8747e057 HEAD -- packages scripts examples` adds no `TODO` or `FIXME` line.

### Every item still deferred at the start of this pass

| Item                                                                                    | Where it ends                                                                                                                                                                                                                                                 | Row                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| D182 (F6, F10 and F25 waiting for D179)                                                 | D179 landed; each item has its own row below, and D182 points at them                                                                                                                                                                                         | D184-D186          |
| F6 `quality-push-skipped-imperative-list` (and 2026-11-05 `quality-push-skipped-top15`) | Trial `readerVerbGate`, package `action-gate-verbs-trial`: 62 hidden and 62 control skipped of 768, 46 of the hidden already surfaced (ceiling +16); deleted by its pre-set rule (hidden -1, reader calls +17.4%)                                             | D186               |
| F10 `moonshot-ask-query-expansion-ceiling`                                              | Closed, not built: 45 of 384 hidden unranked at top 60; about 3-6 tasks gained (estimate: 45 × 0.065..0.130), at or just above ±3 noise; closed on D115's false concerns 0.0% to 4.7% and D89's own Budget, call and COST-MODEL line; reopen at >15% unranked | D184               |
| F25 `devloop-retrieval-screen-set-subset-replay`                                        | Not built: a paid arm costs about $0.19, a top-up cents; an unordered replay is looser than D117's 493 of 600                                                                                                                                                 | D185 (D117 stands) |
| 2026-11-05 O7, the unranked quarter                                                     | 92 unranked, then 64 after D158, now 45 at top 60; the remaining bridge is F10, closed                                                                                                                                                                        | D184               |
| The preset screen predates D179 (Closing)                                               | Re-run above with the replayed paid reader; only minus `fallback` differs, and it is kept                                                                                                                                                                     | D183               |
