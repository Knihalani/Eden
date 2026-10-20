# R10 build plan: memory that holds at massive scale

What to build so Eden delivers the memories a turn needs, unasked, when a user has millions of memories, many years
of history and many devices, and Eden serves many users. It is a plan, not a slice spec: each phase below becomes
slices under the normal lifecycle (CLAUDE.md), with pre-registered gates. Every number comes from `LEDGER.md`; the
experiment id is next to it. Numbers marked **estimate** are arithmetic, not measurement.

## 1. Where we are

The share of needed memories that reach the agent, step by step (dev turns, synthetic worlds, today's design with
the checker; C11-E1 pre-registration):

| Step | Code | Personal assistant |
|---|---|---|
| The needed fact exists in the store at all | 84% | 67% |
| It is among the 15 rows the hook shortlists | 61% | 40% |
| The checker keeps it | 55% | 36% |
| It is delivered in time | 52% | 27% |

Each step loses some. To reach 95% the plan has to fix all four, and at scale the middle two get harder: a store a
thousand times larger buries the needed row deeper.

What the research found (cycle 11):

- **Ranked lists fail at scale.** One ranked list of the store's rows (the hook's lexical + bank ranking) reaches
  61% / 40% at 15 rows and needs far more rows to reach the rest (C11-E1).
- **Typed channels find almost everything** (C11-E2): rows tagged with the action the turn involves (booking, deploy,
  purchase …), rows naming an entity the turn names, and rows dated near the turn. Together they hold 100% / 97.1% of
  the needed rows that exist.
- **But two of those channels grow with the store** (C11-E6). The action channel is about 42–48% of the store at
  every size (slope 1.17); the entity channel grows in proportion in the personal world (slope 1.18; median 19.5%
  of the store per turn), where a few hub entities (partner, children, home) appear on many rows. Extrapolated to a
  million rows, they would hand over hundreds of thousands of candidates per turn. Capping them by any cheap order
  loses 17 points of recall on code and 26 on the personal world (C11-E2: 82.8% / 71.0%, from 100% / 97.1%).
  Dropping hub entities bounds the entity channel but loses 24% (code) and 42% (personal) of what it found (C11-E7).
- **Dreaming can compress them into fixed-size cards** (C11-E4): a card per action type, at most 20 lines, kept
  up to date batch by batch, each line citing the rows behind it. Cards alone reach 84.5% (code) / 79.7%
  (personal); with the other bounded channels, 96.6% / 88.4%, in a pool of 77 / 82 lines and rows at the median
  (138 / 153 max) whose size depends on the turn's action types, not on the store. The bounded union without cards
  was 82.8% / 71.0%.
- **Dreaming drops episodes and tool results** (C11-E3): what happened in a session (an order placed, a route
  looked up, a booking made) mostly never becomes a row. A per-session episode layer raises the personal world's
  ceiling from 67.0% to 80.6% (C11-E5): episodes 4 → 11 of 15, tool results 1 → 7 of 8.
- **The checker is fast enough for a wide pool, not yet accurate enough** (C11-E8): Jev checks 150 candidates in
  about half a second (p90 0.556 / 0.624 s), but finds 63.5–74.1% of the needed rows it is shown (top 4 picks) and
  fires on about half the turns that need nothing. Its requests at 150 rows already use 58–65k input tokens, at
  Jev's 64k-token limit.

So the design below is: dreaming does the hard work offline and writes bounded structures; the hook reads them
cheaply; one fast decision model picks from a bounded pool; delivery stays push-based and fail-open.

## 2. Rules that hold at every scale

1. **Per-turn work does not depend on store size.** The hook and the checker touch a bounded number of rows (target
   ≤ 150) whether the store holds 10^3 or 10^7. Anything that grows with the store is precomputed by dreaming.
2. **Per-session dreaming cost does not depend on store size.** A session's dream touches its own events, plus the
   cards and rows linked to the entities and action types it involves. A global pass is a rare compaction job.
3. **Eden decides, unasked.** No tool the agent must call. Delivery is push.
4. **No model on the hook.** Models run off the hook (D37 as amended: the in-turn checker, opt-in) or offline
   (dreaming, on sanitized text).
5. **Fail open.** Every failure means "deliver nothing this turn", never an error and never a blocked prompt.
6. **Every delivered line is dated and traceable** to the session it came from.

## 3. The system in one picture

```
 session events ──► WRITE PATH: event log (append-only) + instant capture of explicit facts
                         │
                         ▼   after each session (offline, batched)
                    DREAMING: episodes · semantic rows · entities · action tags · time
                         │    then consolidation: supersession · cards · roll-ups · forgetting
                         ▼
                    INDEXES + CARDS (per user, on disk)
                         │
 user turn ──► HOOK (no model, ms): bounded candidate pool + cards that apply ──► spool
                         │
                         ▼   off the hook, in the turn (≤ 1 s measured for the parts)
                    CHECKER (Jev): which action types? which candidates matter?
                         │
                         ▼
                    DELIVERY at the first tool call (or the next turn's Submit): ≤ 8 dated lines
                         │
                         ▼
                    FEEDBACK: what was used, ignored or corrected ──► dreaming and checker calibration
```

## 4. Write path

- **Event log.** Every session's events (user turns, assistant replies, tool calls and results, notifications) go to
  an append-only, per-user log, compressed, with the session id and timestamp. It is the source of truth; everything
  else can be rebuilt from it. Tool results are truncated to a size budget, never dropped (C11-E3: tool results are
  what is lost today).
- **Instant capture.** An explicit "remember …", a correction ("no, it's Postgres now") or a stated preference becomes
  a provisional row at once, so it is available before the next dream. Model-free patterns at first; the dream later
  confirms, rewrites or drops it.
- **Sanitizing.** Secrets and credentials are masked at write time (gitleaks rules, D13) before anything reaches a
  dream model or the checker.
- **At scale.** **Estimate:** 20 sessions a day × 30 events × ~1 KB ≈ 600 KB a day before compression, ~200 MB a
  year per heavy user; trivial for local disk, and the log can be tiered to cold storage after roll-ups.

## 5. Dreaming (the centrepiece)

Dreaming turns raw sessions into structures that make reading cheap. It runs offline after a session or in a nightly
batch, on sanitized text, with a model chosen by measurement (NIM, Claude batch or similar; D37).

### 5.1 Per-session compile (cost ∝ session length)

For each finished session, one pass writes:

1. **Episode records** (C11-E5): what the user asked or decided, what was done, what tools returned, each dated and
   with its entities. ~3 per session in the personal world (485 for 160 sessions).
2. **Semantic rows** (today's sleep compiler): facts, preferences, rules, routines, plans, commitments, with compiled
   cues, kind, entities and times.
3. **Entity mentions**, resolved to stable entity ids (5.3).
4. **Action tags** per row and per episode, from the action taxonomy (28 types today, `dream/actions.json`; new types
   proposed by the dreamer and admitted by a rule, 5.6).
5. **Time fields**: absolute dates and recurring patterns, normalised to intervals.

### 5.2 Consolidation (cost ∝ what the session touched)

After the compile, the dream updates only what the session's entities and action types point to:

- **Supersession, scoped by entity and action.** A new row that replaces an old one (Node 18 → 20.11, MySQL →
  Postgres) marks the old one invalid. Today this is done within a batch and across batches (C5-E5); at scale the
  candidates for supersession are found through the entity and action indexes, not by scanning the store.
- **Open conflicts stay visible.** When two rows disagree and nothing settles it, the card says so ("vendor:
  GrowthBook per 2026-08, later called unconfirmed"). The code card run left three such conflicts open, correctly.
- **Action cards** (C11-E4): per action type, ≤ 20 lines of what would change how the assistant does that action:
  standing rules, preferences, routines, commitments, upcoming plans, known gotchas. Each line cites its rows. The
  dream rewrites a card only when the session touched its type.
- **Entity cards for hub entities** (C11-E6/E7): an entity becomes a hub when it is on more than max(5, 2% of rows).
  Each hub gets a ≤ 20-line card (who/what it is, the current state, standing preferences, upcoming events). Non-hub
  entities stay in the entity index. **Estimate:** at 10^6 rows, a few hundred hubs at most; the card set is bounded
  by a hub cap (e.g. 500, least-recently-used hubs fold back into the index).
- **A "now" card**: active plans, deadlines and commitments in the next 14 days, and anything the user said to raise.
  Rebuilt nightly from the time index.
- **A profile card**: the user's stable identity, tools, accounts, standing rules. Small, rarely rewritten.

### 5.3 Entity resolution

The same thing has many names ("Riya", "my wife", "R."; "the API", "api-gateway"). The dream keeps a per-user entity
table: id, canonical name, aliases, type, first/last seen, row count. New mentions are matched by alias and context;
ambiguous merges are left unmerged and logged. This is what makes the entity channel and hub cards work, and it is
also what makes supersession safe at scale (only rows about the same entity can supersede each other).

### 5.4 Roll-ups and forgetting

- **Episode roll-ups**: per week, then per month, the dream writes a summary of episodes per entity and action type
  ("Nov 2025: three cake orders from Bobbette & Belle"). The raw episode records stay in the log and stay findable by
  entity and date; only the summaries sit in the hot index after 90 days. This keeps the hot store roughly
  proportional to active life, not to total history.
- **Forgetting**: rows that are superseded, past (an event that happened) or never used fall to cold storage after a
  grace period; commitments and standing rules never decay by age alone. Nothing is deleted without a user rule;
  "forget" is moving out of the hot index. A user's explicit "forget this" deletes, everywhere, including the log.

### 5.5 Dream cost at scale

- Compile: proportional to the session (**estimate:** a 30-event session ≈ 15–30k input tokens).
- Consolidation: proportional to the cards and rows the session touched: ≤ ~5 action cards and ≤ ~5 hub cards ×
  20 lines, plus supersession candidates from the indexes (bounded, e.g. 50).
- Roll-ups: weekly, proportional to that week's episodes.
- No step reads the whole store. A full rebuild from the log is possible (for a new dream version) and is a batch
  job, run rarely, per user.

### 5.6 Keeping dreaming honest

Dreams can be wrong, and a wrong card is delivered often. So:

- **Validators** (deterministic, every dream): each card line cites rows that exist and are valid; a card has ≤ 20
  lines; dates parse; superseded rows are not cited; no secret patterns.
- **A dream eval set**: the StreamBench worlds plus held-out ones, scored on store ceiling (is the needed fact
  anywhere?), card recall (C11-E4's measure), and false or stale lines. A new dream prompt or model ships only if it
  does not regress them.
- **Taxonomy changes** (new action types) need a minimum number of rows and a check that the new card beats the old
  type split on the eval set.
- **Provenance**: every card line links back to rows, every row to sessions; the user can ask "why do you think …"
  and see the source.

## 6. Indexes (written by dreaming, read by the hook)

Per user, in one local database (SQLite today; a server store for hosted Eden).

| Index | Holds | Read cost per turn |
|---|---|---|
| Lexical (BM25 over row text + cues) | valid rows, episode summaries | top 15, ms (inverted index) |
| Self-play bank | likely future prompts per row | top 15, merged with lexical (G0) |
| Entity index | entity id → rows, with row counts | rows for non-hub entities the turn names, cap 20 |
| Time index | intervals → rows | rows due within 14 days or on a weekday/month the turn names, cap 10 |
| Action cards | ≤ 20 lines per action type | the turn's types' cards |
| Hub entity cards | ≤ 20 lines per hub | cards for hubs the turn names |
| Now card, profile card | ≤ 20 lines each | always available |

**Estimate at 10^6 rows:** row store ~1 GB with cues; indexes a few hundred MB; cards a few MB. Lexical top-k over an
inverted index stays in milliseconds; the entity and time lookups are key lookups with caps.

## 7. Read path, per turn

1. **Hook (UserPromptSubmit, no model, target ≤ 50 ms).** Builds the candidate pool: G0 top 15, rare-entity rows
   (cap 20), time rows (cap 10), the now card, and the cards of hubs the turn names. Writes it to the spool for the
   checker and returns. Injects nothing (or, behind a flag, the now card's lines due today).
2. **Checker (off the hook, Jev, opt-in).** Two requests, the second right after the first:
   - which action types the turn involves (one yes/no per type, 28 today; C11-E2 used this);
   - for the pool plus the lines of those action cards (≤ ~150 items): does the assistant need this now? Measured:
     about 0.25 s and 0.5 s (C10-E1, C11-E8), so both fit in the ~3 s before the first tool call (C8-E4).
   - A request of 150 rows is already at Jev's 64k-token limit (C11-E8: 58–65k input tokens at pools ≥ 140). Any
     added context (card lines, "applies when") means splitting the questions into parallel requests that each
     carry the state (C11-E11); each part pays for the state again, and parallel parts are unmeasured.
3. **Delivery** at the turn's first tool call: up to 8 lines (C11-E8: 8 instead of 4 adds 5.2–7.9 points of recall),
   each dated. Turns with no tool call: the picks wait for the next turn's Submit only if still relevant (a turn
   rarely shares needs with the one before, C8-E5, so this is a small gain; the open gap is 11 of 49 personal need
   turns).
4. **Fail-open.** No pool, no checker answer in time, any error: nothing is delivered.

**Cost at scale (estimate):** measured input per checker call (C11-E8 `usage`): median 38,176 tokens on code and
58,703 on the personal world, about 62k at pools ≥ 140. At $0.042 per million input tokens (TypeSafe's list price
as read on 2026-10-19; not re-checked in R10), that is about $0.0016–0.0026 per turn. 10^6 users × 50 turns a day
≈ $80–130k a day; that is the number to bring down (smaller pools on easy turns, skipping turns the hook scores as
small talk).

## 8. Getting recall to 95%

| Step | Today | Lever | Evidence | Target |
|---|---|---|---|---|
| Fact in the store | 84 / 67% | episode layer, kept tool results, instant capture | C11-E5: 67.0 → 80.6% (life) | ≥ 95% |
| In the bounded pool | 61 / 40% at 15 rows | typed channels + action cards + hub cards | C11-E4: 96.6 / 88.4% at pool ≤ 153 | ≥ 97% |
| Checker keeps it | 0.635–0.741 of what it is shown at ~150 (0.758–0.892 of G0's rows) | see below | C11-E8 | ≥ 95% |
| Delivered in time | most | delivery at Submit for no-tool turns | C8-E1 | ≥ 98% |

The checker is now the weakest step. Work on it, in order of expected value:

1. **Give the checker the cards as context.** A row is easier to judge when the checker knows the user's standing
   rules and current plans. Untested.
2. **Two passes: tested, no gain** (C11-E9). A narrow second pass over the wide pass's top 15 gives the same
   recall (code 0.776, life 0.714): Jev judges a row the same among 150 candidates or 15.
3. **An implied-step question: tested, small gain** (C11-E10). Asking whether a row governs a step the user did
   not name finds one or two more rows per world (code 0.793 → 0.810, life 0.714 → 0.746) and fires on more turns
   that need nothing (code 29 → 37 of 55).
4. **Show the dream's "applies when": tested, small mixed gain** (C11-E11). Best where the cap is tight (life,
   top 4: 0.635 → 0.714) and fewer no-need fires on code (29 → 23); at top 8 within an item or two of the plain
   check. Worth keeping (it costs nothing but tokens); requests over 64k tokens must be split.
5. **Average two calls: tested, no gain** (C11-E12). Under 0.4% of row decisions flip between calls; recall is
   the same.
6. **Show the bank's example requests: tested, a trade** (C11-E13). Jev fires on far fewer no-need turns (life
   38 → 20 of 79) and finds fewer needed rows (life 0.714 → 0.667 at top 8). Useful if precision matters more.
7. **Learn from feedback.** Per-user calibration of the threshold from what the agent used.
8. **Deliver more when it is cheap.** Up to 8 lines; no measured harm on turns that needed nothing (C6/C10 outcome
   tests). The cost to watch is context bloat, which A5's counter-metrics already track.

Honest status: no configuration measured so far reaches 95% end to end. A rough **estimate** from the measured steps
(rough because each factor comes from a different pool, and delivery is left out): code 0.84 × 0.966 × 0.793 ≈ 0.64;
personal 0.806 × 0.884 × 0.714 ≈ 0.51. Even with the store at 0.95 and the pool at 0.97, a checker at 0.8 gives about
0.74 (**estimate**, targets not measurements). Getting the checker from 0.7 to 0.95 is the open research problem of this
plan. Four of the designs tried (C11-E9 to E12) land at 0.776–0.810 on code and 0.714–0.746 on life (top 8); the fifth
(C11-E13) is stricter and lower (0.741 / 0.667). The misses left are rows whose link to the turn takes a step of
reasoning (a YouTube embed → the site's CSP headers). Two routes remain: have dreaming write those links ahead of time
(concrete situations per row, as the self-play bank does for prompts), or send only the hard cases to a slower reasoning
model and deliver at a later tool call.

## 9. Feedback

- **Signals** (model-free, from the transcript the hooks already see): the agent quoted or acted on a delivered line;
  the user corrected it ("no, that's old"); the user repeated a fact Eden should have known (a miss).
- **Uses**: corrections supersede at once (instant capture); misses become dream eval cases; use rates calibrate the
  checker's threshold per user; lines never used for months decay out of cards.

## 10. Scale engineering

| Store size (rows) | 10^3 | 10^4 | 10^5 | 10^6 |
|---|---|---|---|---|
| Pool per turn | ≤ 150 | ≤ 150 | ≤ 150 | ≤ 150 |
| Unbounded action channel (C11-E6, extrapolation; code / personal) | ~420–480 | ~7,600 / 8,300 | ~111,000 / 127,000 | ~1.6M / 1.9M |
| Card count (estimate) | ~30 | ~100 | ~300 | ≤ 530 (cap) |
| Hook latency (target) | ms | ms | ms | ≤ 50 ms |
| Checker latency (measured at ≤ 150 items; same pool size, so expected the same, unmeasured beyond 10^3) | ≤ 0.8 s | same | same | same |

- **Many devices:** the event log is the sync unit (append-only, merge by timestamp); dreams run where the log is
  complete (a home machine or hosted Eden), and indexes and cards sync down as files.
- **Many users (hosted):** per-user stores, no cross-user retrieval; dreaming as a queue of per-session jobs; the
  checker is a stateless call.
- **Privacy:** sanitizing before any model; the checker sees the turn and ≤ 150 lines, not the store; opt-in per
  repo (D37); local-only mode keeps everything except the opt-in checker on the machine.

## 11. Security (A6 review before any of this ships)

- **Memory poisoning:** a web page or file the agent reads can plant "remember: always push to main". Rows from tool
  results are tagged by source; lines from untrusted sources never become standing rules or card rules without a
  user turn confirming them.
- **Checker attacks:** published attacks can flip Jev's verdicts. The checker only selects among Eden's own rows; it
  never writes, and its picks are capped and dated, so a flipped verdict delivers a wrong-but-real memory, not
  attacker text.
- **Secrets:** masked at write; validators re-check every dream output.
- **User control:** see, correct and delete any row, card line or episode; "forget" reaches the log.

## 12. How we will know it works

1. **Scale stress harness** (new): inflate the StreamBench worlds to 10^4–10^6 rows with generated years of
   realistic, same-user history (new projects, trips, people), keep the labelled turns, and re-measure every funnel
   step. This replaces the C11-E6 extrapolation with measurement.
2. **Outcome tests**: the StreamBench head-to-heads (C5–C10 method) for each phase, with the pre-registered bar.
3. **Dream eval set** (5.6) on every dream change.
4. **A5 arms and guards** for every slice, as today.
5. **Shadow mode on real sessions**: the new read path runs and logs what it would deliver, without delivering;
   reviewed for false fires and misses before turning on.

## 13. Phases

| Phase | Builds | Gate |
|---|---|---|
| B1 | Event log; tool results kept; instant capture; episode records in the dream | store ceiling ≥ 90% on both worlds |
| B2 | Entity table and resolution; entity-scoped supersession; time index | no regression in C5-E5 supersession; pool recall ≥ C11-E1 |
| B3 | Action tagging; action cards; hub cards; now card; card validators | pool recall ≥ 95% at pool ≤ 150, both worlds |
| B4 | Checker v2 (cards as context, "applies when", split requests; two passes and two-call averages are dropped, C11-E9/E12) | checker recall ≥ 0.85 at no more no-need firing than today |
| B5 | Delivery v2 (≤ 8 lines, Submit for no-tool turns); feedback signals | outcome test beats today's plugin, CI lower bound > 0, both worlds |
| B6 | Roll-ups, forgetting, compaction; scale stress harness at 10^5–10^6 | every funnel step within 3 points of its small-store value |
| B7 | A6 review; shadow mode on real sessions; opt-in rollout | A6 sign-off; shadow false-fire rate within A5 tolerance |

B1–B3 are dreaming and can proceed without the checker decision. B4–B5 depend on D37's checker (amended, opt-in).

## 14. Decisions the user owns

1. Whether D37 should name the outcome measure (C10-E3/E4) instead of the C9-E1 retrieval rule for the checker.
2. Whether hosted Eden (server-side dreaming and indexes) is in scope, or local-only with optional sync.
3. Which dream model provider (NIM, Claude batch, other), and the monthly budget per user.

## 15. What is not known yet

- Everything here is measured on synthetic worlds of hundreds of rows; the scale numbers are projections until B6.
- Whether a dream model can keep cards accurate over years (drift, stale lines) is untested; the card run covers 11
  and 16 batches.
- The checker's accuracy is the main open problem (section 8).
- No real-user transcripts have been used.
