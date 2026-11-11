# Eden: weak points and bottlenecks, with proposed fixes

Analysis of `main` at `65a76213c` (#244), 2026-11-11. Analysis only: no repo file changed, no paid call, nothing
pushed. `git status` was clean at the end.

## How to read this

- **[M]** = I measured it in this session with a $0 command (listed in §1).
- **[C]** = I read it in the code at the line given.
- **[N]** = taken from a research note or decision; not re-measured by me. Almost every live (paid) figure is [N].
- **[EST]** = my arithmetic or judgement.
- All live figures in the notes are "Anthropic-direct lab figures" on simulated worlds with Haiku 5.5 as the agent
  unless said otherwise. None is from a real user or a real connector.

**What I read.** In full: CLAUDE.md, VISION.md, INTEGRATION.md, packages/engine/CLAUDE.md, render.ts, and the notes
b18-heldout18, o1-earn, o1-sweep, o3-push-open, o3-pointer, o3-pool-recall, o3-check-behind, o4-new-user,
o4-per-source, o4-segment-screens, o5-items, o2-users-per-box, o2-dev-loop, o2-proxy-messages, n3-long, n4-agents.
In part (summary sections, tables, the parts the evidence pointed to): DECISIONS.md (the trials table, D750–D802 in
full, and the title of every decision that killed or rejected something; I did not read all 706 KB), ARCHITECTURE.md,
COST-MODEL.md, LAB.md, TESTING.md, PRIVACY.md, THREAT-MODEL.md, a29-heldout17, n1b, n5, i2, i3, packages/eval/CLAUDE.md,
sync.ts, probes.ts, partner.ts (by search), the clients, mcp.ts. Not read: research/INDEX.md beyond searches, the
other packages' CLAUDE.md files, the proxy's source. Where a claim rests on a part I did not read, it is marked [N].

---

## 1. What I measured myself ($0)

| Command | Result | Against the brief or the docs |
| --- | --- | --- |
| `bun run eval` | precision 0.65, recall 0.52, falseFireRate 0; 10.1 s | Matches CLAUDE.md |
| `bun run eval --config '{"pushOpen":false}'` | identical: 0.65 / 0.52 / 0, 40 delivered | The merge gate cannot see `pushOpen` at all (§3 B1) |
| `CHECK_COLD=1 bun run test`, twice | **69.4 s with 1 failure**, then 64.1 s green; 2,672 tests, 235 files | The brief and o2-dev-loop say about 55 s. It has grown, and it flaked |
| `bun test packages/engine/src/rare-terms.test.ts` alone | 9 pass, 3.5 s | The same file timed out (7.3 s against a 5 s limit) inside the parallel cold run |
| `bun run typecheck`, `bun run format:check` | 22.6 s, 3.2 s | So the cold gate is about 90–95 s here, not 58 s |
| `bun run funnel` | hidden 315/384, decoys 276/384; 14.1 s | Matches. Candidates path: 289 facts handed, 247 decoys handed |
| `bun run funnel --ask` | "unknown flag --ask", exit 2 | CLAUDE.md lists `--ask` as a funnel flag. It is not one |
| `bun run funnel --jobs 4 -- --neutral` | nothing-to-add requests given a packet: 92/96, 91/96, 94/96 (three shards read); 4.3–4.7 items and about 1,010–1,100 bytes a task | Agrees with "about 98%" (the note's figure is live, over days) |
| `bun run demo` | scenario 1: the fact plus four unrelated invoices in one packet | Illustrates packet precision |
| A probe of `isOpenRequest` / `isImperative` on 15 messages (scratch script) | "Should I book the 7am flight…?", "I need to pay Dean's invoice today", "I want you to book…", "We should move the offsite…" start **no push**. A log line, "ok so anyway the weather is nice today" and French and German imperatives **do** | Not in any note (§2 Q6) |
| grep of the six train suites' request texts | 0 of 236 request strings open with a question word or "I need / I want / We should" (heldout18: 1 of 37) | The lab cannot see Q6 |
| `wc -l packages/engine/src/partner.ts` | 7,022 lines | packages/engine/CLAUDE.md says "about 5,130" |

---

## 2. Weak points

### A. Quality

#### Q1. Over a user's days, a third of hidden facts never reach the agent that day

- **What:** the fact a request needs is not among that request's five candidates and was not handed earlier that day.
- **Evidence:** [N] o3-pointer.md §3.1: 134 of 433 hidden tasks (31%), 32 users, 0 of them raised. D712. At $0 on
  w45–w52: of 23 such misses 16 were outside the pool's 15, the rest cut or failing the constraint test (§3.2).
  One request a session: 136 of 768 never handed (o3-push-open §4).
- **Size:** the largest single loss. If every one were handed at its own request and raised at the 88% rate, days
  would go from about 54% to about 81% [EST]; a realistic half of that is +13 points [EST].
- **Root cause:** the pool is lexical plus intent hits. A user's world holds every template's constraint and its
  decoy, so the five seats fill with other requests' constraints. The fact often shares no word with the request
  (heldout18's anchored third: 44% Sonnet-graded, 31% Haiku-graded).
- **Proposed:**
  1. *An alias table per user* built at ingest with no model (first name ↔ surname ↔ role ↔ card or order
     reference ↔ numeric date forms), used to match a request's anchors to items. Aimed at the anchored templates.
     Measure: `days-calls.ts --pool-diag` at $0 (facts pushed at their own request, decoys pushed), then one
     pre-registered days run. Gain [EST]: +3 to +6 points on anchored-style requests; unknown on train. Risk: more
     decoys handed. No owner decision.
  2. *A request embedder for `pushWiden` without the check* (D511 is gated on the check today). $0 screen first with
     the lab's offline table: do facts enter the top five, or only the top fifteen? Needs a decision on a new
     dependency and on about 20–50 ms of path time.
  3. *The paid check* (Q4's item 1) is the only thing measured to move this: +7.9 points (N5).
  4. *Check the lab first* (§3 B6): the density of constraint items in one simulated user may be making this miss
     larger than a real mailbox would.
- **Prior attempts (do not repeat):** full intent coverage, +2 of 113 (D713); eight candidates or no settled cut,
  no gain (o3-pool-recall §3); `pushReach` (D330); `pushCandidateLift` re-rank (D266); `askExpand` (D189);
  stored-answer check (D526, D529); distilled checker (D492); card tags (D286).

#### Q2. One handed fact in five is not raised

- **What:** the agent holds the fact and states its core without the consequence, or reasons past it.
- **Evidence:** [N] o3-check-behind §4: of 291 misses on 768 hidden tasks, 119 had the fact in hand. 431 of 535
  raised from a push packet (81%). N4: from the same packets Sonnet raises 80%, Opus 75%, Haiku 65%.
- **Size:** about 15 points of hidden facts with Haiku; much less with Sonnet [EST from N4].
- **Root cause:** mostly the agent model and the grader, not Eden. The fact is one line among four or five
  look-alikes behind a lead that says "ignore it if it does not match". LAB.md recipe 4b: Sonnet called 18 of 38
  Haiku-graded in-packet misses raised, so part of this is grading.
- **Proposed:** do not build. First run the default against tools with Sonnet as agent on all 192 templates,
  one seed (about $5 [EST]) and read "in hand, not raised" there. If it falls under 10%, close the item for the
  agents tenants will use. If not, the lever is fewer look-alikes in the packet (Q4), not more words in the lead.
- **Prior attempts:** `candidatesSpecifics` +2.0 (D705); `linkLine` (D360); constraint-first excerpts (D268);
  `pushCovered` (D250); 200-byte excerpts lost facts (D258).

#### Q3. A fact handed for an earlier request the same day is raised 60% of the time, against 88%

- **Evidence:** [N] o3-pointer §3.1: 110 tasks, 66 raised. The not-twice ledger (D13) keeps it out of its own
  request's packet.
- **Size:** at most 110 × 0.28 = 31 tasks of 433, +7 points [EST ceiling].
- **Root cause:** the item ranks for many requests, is handed early under "ignore if it does not fit", and never again.
- **Proposed:** one pre-registered days run of the pointer on today's default on fresh users (o3-pointer §3 saw
  +2.5, +0.2..+4.9 for pointer-beside-open, unplanned). About $7 [EST]. Kill it for good if under +2.
- **Prior attempts:** `pushReshow` (D340, deleted D380); `pushCheckReshow` −10.9 (D512); `pushPointer` alone −1.2
  (D711); shortening earlier packets −16 points (D517).

#### Q4. Eden hands the look-alike almost as often as the fact, and a packet on nearly every request

- **What:** the default does no vetting. Precision is left to the agent.
- **Evidence:** [M] funnel: candidates hand 289 facts and 247 decoys of 384 each. [M] 92–94 of 96 nothing-to-add
  requests get a packet of about 4.4 items. [N] live: decoy in a packet in 1,010 of 1,535 control tasks; 98% of
  neutral requests over days (D710). THREAT-MODEL.md says the same and calls it a data-minimisation cost.
- **Size:** Sonnet-confirmed false concerns stay at 0–4 per 3,000 answers, so the measured harm is small. The costs
  are elsewhere: the agent's tokens (C1), unrelated user text sent to the tenant's model on every request, a wider
  injection surface, and total dependence on the agent model's discipline (only three Anthropic models tested).
- **Root cause:** D237 made the agent the reader. `pushOpen` then opened the gate to every instruction-shaped message.
- **This contradicts a stated rule.** VISION principle 1 and CLAUDE.md say "silence by default; precision over
  recall". The shipped default speaks on about 98% of requests. The gate's `falseFireRate 0` does not measure it (B1).
  Either the rule or the default should change, by a numbered decision.
- **Proposed:**
  1. *Owner decision on the push check.* N5's compare-first check with a widened pool: +7.9 points (+5.3..+10.7),
     neutral packets 135 → 9 at $0 (I2), for +$0.21 per 1,000 tasks and +1.06 s. Arm N (never silent, anchored
     gate): +2.7 for +$0.04–0.08 and +0.3–0.4 s. The bounds it failed are +$0.10–0.20 and +0.1–0.3 s. Two facts the
     bounds did not weigh: Eden's arm is already 1.06 s faster than the agent with tools (B18), and $0.21 is 2% of a
     Sonnet agent's $9 per 1,000 tasks (N4). This is the best measured quality lever in the repo and it is parked.
  2. *The mild filter that was screened and not built* (o3-push-open §5): push on an opened request only when a
     constraint-like item is among those handed: −25% of the added neutral packets for −8% of the added facts.
  3. *Per-tenant choice*: document `open` and `candidates` as parts a privacy-strict tenant takes out, with the
     measured price (−4.1 points for `open`).
- **Prior attempts:** distilled checker (D492); check behind the packet +0.0 (D704); stored answers (D526);
  thinking on the short reply (D528); rule-path labels and vetoes (D195–D197); score floor (D258).

#### Q5. With no change notice, a third of owed updates never arrive

- **Evidence:** [N] o1-sweep.md: 188 of 279 (67%); 90 of the 91 lost because the source was not polled. Calendar
  0 of 6, documents 0 of 2, chat 6 of 24, mail 90 of 99. [C] `sync.ts:1073–1081`: a copy is current while the chance
  of a *new item* is under `syncStaleChance` and its poll is under `syncMaxStaleMs` (6 h, `config.ts:848`).
- **Root cause:** the rate is of new items. It says nothing about an edit to an item the agent already holds.
- **Size:** for calendars and documents, which are the sources where a silent edit matters most (a moved meeting),
  the lab's rate is 0 of 8. The lab's case is the hardest (the move lands just before the session's last request).
- **Proposed:**
  1. *Re-read only the items the agent holds* from quiet, non-notifying sources, by id, before a request, capped at
     two fetches a request (the idea o1-sweep notes and did not build). Measure with `days-calls.ts --recap-notice
     none`: updates of 279 against calls a request. Gain [EST]: most of the 91, for under +0.5 calls a request,
     against +1 call per 12 updates for the listing rule.
  2. *It cannot work on the shipped presets as they stand*: [N] INTEGRATION.md: no preset names a fetch tool (D415).
     So the fix needs verified fetch tools for Gmail and Calendar first (D2).
  3. *Make notices the paved road*: with notices 279 of 279 arrive. A webhook receiver example per provider.
- **Prior attempts:** `syncOwedPollMs` in five forms (D606: +1 call per 12 updates); higher `syncStaleChance`
  halves updates (D605); `verifyByPoll` (D345); `syncCoalesceMs` (D213); re-reads by age +4.6 calls a task.
- **Owner decision:** how many connector calls a recovered update is worth, on per-call plans.

#### Q6. The push starts only for imperative English

- **What:** requests phrased as a need, a plan or a question about acting get no candidates packet. Non-English
  text passes the gate by accident, and the no-model lexicons behind it are English.
- **Evidence:** [M] the probe in §1. [C] `probes.ts:83–92`: `ASKING` holds "should", "is", "do"; `STATING` holds
  "i", "we", "the", "my". [M] 0 of 236 train request strings have these forms, so no run has seen it.
- **Size:** unknown and unmeasured. If a fifth of real acting requests are phrased this way, it is the same size
  as the miss `pushOpen` fixed (132 of 768, +4.1 points) [EST].
- **Root cause:** the gate was grown on the lab's template wording.
- **Proposed:** a trial that treats "I need to / I want to / I'd like to / we should / let's / should I / can I /
  is it OK to" plus a known verb as a request. It needs a suite variant first: the same 192 templates reworded
  (no new facts, so cards and intent replay). Measure facts handed and neutral packets at $0, then live. Risk: more
  packets on statements. A language decision (which languages Eden supports) is the owner's.
- **Prior attempts:** D168 (a wider verb list for the *paid* reader: +17% calls, deleted). That cost no longer
  applies (the push makes no call), which is why `pushOpen` passed.

#### Q7. A new user's first request, and a new 1,000-source user

- **Evidence:** [N] o4-new-user: at second 0 Eden surfaces 46–52% against 80% settled. Live at 10 s: 65.1% against
  34.9% before `syncKick`. A new 1,000-source user reaches full strength at about 45 s.
- **Root cause:** the first request runs before anything is read. Follow-up packets are not taken (A4).
- **Proposed:** (a) have the server kick the backfill when the user's sources are first resolved or listed
  (`/v1/sources`, the directory), so it does not depend on the integrator sending `session_start`; (b) a static
  per-connector-kind prior shipped with Eden (mail and calendar first), screened with the funnel's
  `--connect-at`; (c) the tenant-count prior (o4-new-user §5a) only if (b) fails. (c) crosses D9: owner decision.
- **Prior attempts:** `syncCold`, `syncDelta` (D495); card-only model for the backfill (D523).

#### Q8. Late facts: 60% are still not raised after a plan alert is taken

- **Evidence:** [N] n3-long §2: 153 of 380 with the alert, 62 of 420 without. Partial run (shards hit their cap).
- **Proposed:** one wording trial plus one repeat at the next request, on `--late` with a $0.55 shard cap. Bar: +8
  points, Sonnet-confirmed false alarms not up, agent cost under +10% (it passed at +8.8%, narrowly).

#### Q9. The agent seldom asks, and stops asking after about four requests

- **Evidence:** [N] asks in 212 of 768 hidden tasks; 127 never handed and never asked (o3-check-behind §4). From a
  day's fifth request on: 12 asks in 352 requests, 0 in 216 on long days (n3-long §5).
- **Root cause:** a packet on every request teaches the agent that Eden has already spoken.
- **Proposed:** nothing on the ask itself; three wordings failed. The gain is in the first packet (Q1, Q4).
- **Prior attempts:** `askReinvite` (D518), `+terse` (D335), `askMulti` (D485), `askPastShown` (D267),
  `pushCandidatesCovers` (D274), `pushChecked` (D257).

#### Q10. The blind level moves 24 points between two suites

- **Evidence:** [N] heldout17 73.4%, heldout18 46.9–49.2% (Haiku-graded, the same default). On heldout18 the gain
  of the wave is +9.4 by Sonnet's grade and +2.3 by Haiku's.
- **What it means:** "Eden raises X% of hidden facts" is not a stable number. Only the gap to tools (+45 to +69
  points) is. Any target such as "90%" needs a fixed suite and a fixed grader first (§3).

### B. Cost

#### C1. The agent's bill: about 500 packet tokens on nearly every request, re-read all day

- **Evidence:** [N] N4: +460–550 tokens written to the cache a task for any model. One request a session: Haiku
  +28%, Sonnet +4.5%, Opus +17.5%. Over one day (16–32 tasks, direction only): Sonnet +20%, Opus +41%, because every
  later request re-reads the day's packets (+7,400–8,900 cached tokens a task). B18 with Haiku: level short, +$0.018
  per 1,000 over days.
- **Root cause:** Q4. Packets on requests that need none, kept in the transcript because dropping them loses facts.
- **Size:** for a Sonnet or Opus tenant with long sessions this is Eden's largest dollar cost, larger than all of
  Eden's own model spend by two orders of magnitude.
- **Proposed:** (1) fewer packets on neutral requests (Q4 items 1–2); at 98% → about 10% of neutral requests the
  day-long re-read falls by most of its size [EST]. (2) The measurement N4 §5 asks for: a powered days run with
  Sonnet as agent, with and without D336's `+ephemeral` layout. About $10 [EST]. (3) Report the packet's share of
  the agent's bill in `digest`, so a tenant sees it.
- **Prior attempts:** smaller excerpts (D258), three candidates (D259), four ways to send fewer bytes (D273),
  compacting earlier packets (D517), moving the cache mark (D401).

#### C2. Connector calls on per-call plans

- **Evidence:** [N] o1-earn: 5.5 calls a task short and 1.9–2.4 over days at 1,000 sources; Zapier MCP $175 and $62–77
  per 1,000 tasks (list prices, *assumed*). Floor: the user's own five connectors, 2.4 on-demand listings and about
  2 searches. Backfill about 1,005 listings a new user. Weekly sweep about 1,000 listings a user a week
  (o1-sweep), all in one minute.
- **Root cause:** no notices, so staleness is guessed and polled; unused sources are swept to catch deletions.
- **Proposed:** (1) notices: 2.2 calls a task with the same facts. (2) Q5's per-item re-read in place of listings
  for quiet sources. (3) Dormant sources (D602) once a suite can price them (B5). (4) Decide `syncSweepSpread`: its
  trial **ends 2026-11-18** and the run that decides it (card tokens priced) is not scheduled; by D112 a trial past
  its date is a bug.
- **Prior attempts:** `syncDormantMs` (D602), `syncUnusedCap` (D756), `probeBatch` (D508), `searchFreshMs` (D507),
  `pushLazy` (D506), `syncCutLive` (D390), the pooled yield rule (D603).
- **Owner decision:** real plan prices; whether never-used sources are held at all.

#### C3. Eden's own model spend is small, and unmeasured on the route that ships

- **Evidence:** [N] COST-MODEL: backfill $0.006–0.022 a user, about $0.026 a user over 30 days [EST there]. Card bill
  59% output, 37% item text, 2% cache reads (o1-sweep). All Anthropic-direct. The servers ship OpenRouter with the
  prompt cache off until D145's one probe is run (trial ends 2026-12-03).
- **Size:** not a bottleneck. The risk is that the shipped route costs 10–28% more per card call than the notes say.
- **Proposed:** run D145's probe (under a cent, needs the owner's key). Stop optimising card cost.
- **Prior attempts:** Message Batches (D242, D146), fewer intent requests (D243), terse requests (D137),
  `intentConstraintOnly` (D177), `readAtIngest` (D233).

#### C4. Per-tenant caps are divided by the process count

- **Evidence:** [N] INTEGRATION.md: on 64 cores a one-user tenant gets $0.39 a day, 3.1 rps and a burst of 6.
- **Proposed:** decide D327's spend leases (trial ends 2026-12-07) and extend the lease to the rate limit.

### C. Speed

#### S1. The agent's wait depends on the integrator's notice type

- **Evidence:** [N] A18: with signal-only notices a request waits p50 1,013 ms and an ask 588 ms; with refs 6 ms and
  2.3 ms. With payload notices Eden's path is about 10–20 ms (o4-segment-screens §6: p99 under 81 ms at 1,000
  sources). B18: Eden's arm 1.06 s faster than tools short, +0.06 s against the previous default over days.
- **Root cause:** a bare signal doubts every held copy; each is re-read before delivery (D126, D211).
- **Proposed:** make refs the only documented path and warn at runtime (one `onError` line and an `explain` reason)
  when a tenant sends bare signals for a source that has a fetch tool.

#### S2. Waking an idle user blocks the process for 110–190 ms

- **Evidence:** [N] o2-users-per-box: thaw p50 143–153 ms of CPU at the 3,000-item cap. o4-segment-screens §5 (one
  scratch run): about half is re-compressing text just decompressed.
- **Size:** every returning user after 30 idle minutes; sliced, but other users' requests queue behind it.
- **Proposed:** keep packed text bytes and the index arrays in the frozen blob (O4's estimate: 10–15 ms). Then
  freeze after 1–2 minutes. Measure with `users.bench.ts`. Bumps `PERSIST_FORMAT`.

#### S3. A restart loses everything by default

- **Evidence:** [N] INTEGRATION.md: no content on disk by default, so a restart re-reads every active user (about 3.6
  minutes of four cores on a full box, A14) and re-lists every connector (per-call cost). Sessions, the not-twice
  ledger and explain traces are memory only. [N] engine CLAUDE.md: `SourceYield` is memory only.
- **Proposed:** make `EDEN_PERSIST_FROZEN_DIR` the documented production default (the owner's privacy decision,
  D8), and persist the session ledger's item ids (ids only) so a restart does not resend or lose the day's state.

#### S4. Card backfill window grows with the user

- **Evidence:** [N] N4: a card call p50 8.0 s under load; 16 calls = 22–32 s on four lanes for about 300 items; "ten
  times the items, ten times the window". Provider rate limits not approached.

### D. Scale

#### SC1. Users per box rest on a number nobody has measured

- **Evidence:** [N] 3,460 users at a quarter active, 8,030 at a twentieth (o2-users-per-box). The active share is
  A14's convention. A live user is 6.3–7.9 MB resident for 4.5–5.3 MB of heap; a 1,000-source user 11.8–14.1 MB of
  heap (o4-per-source, o5-items), mostly items.
- **Proposed, cheapest first:** (1) merge the index's delta tier at the idle tick: 130–180 bytes an item, about
  0.4–0.5 MB a user at the cap, no layout change (o4-segment-screens §1, not built). (2) S2's fast thaw, then freeze
  sooner. (3) Read the active share from one real `EDEN_TRACE=1` log before anything larger.
- **Prior attempts:** the segment redesign (D750: stop), `--smol` (no change), ingest worker (D216),
  `syncUnusedCap` (D756), disk-only frozen users (D652, 1.06–1.2x, a trial).

#### SC2. One machine

- **Evidence:** [N] ARCHITECTURE "deliberately missing": no multi-machine deployment. Users are pinned by
  `hash mod N`; changing `EDEN_PROCESSES` deletes the other count's persisted users.
- **Size:** no failover; a box loss is S3 for every user. Not a problem before the first tenant; a blocker after.
- **Proposed:** consistent hashing over processes first (so a change of N moves 1/N of users), then the same ring
  across machines with the persisted blob as the hand-off. Design note before code.

#### SC3. Storms

- **Evidence:** [N] D753: 300 users connecting at once are synced in 77–80 s; warm users' p99 stays near 50 ms. Four
  kicked users at a time. With four card lanes a storm puts four times the concurrent calls on the card endpoint
  (N4 caveats). The weekly sweep sends about 1,030 listings in one minute per 1,000-source user (o1-sweep).
- **Not measured:** real connector rate limits, the card provider's rate limits, more than 300 users.

### E. Developer experience: the integrator

#### D1. Nothing is published

- **Evidence:** [N] README "Status": no npm, PyPI or image registry. The TypeScript client needs `bun run
  pack:client` from a checkout; the server needs Bun.
- **Proposed:** publish the two clients and an image. Owner decision (naming, licence, support).

#### D2. Connectors are the real time-to-first-value, and none is verified end to end

- **Evidence:** [N] INTEGRATION.md: four presets (gmail, google-calendar, caldav, obsidian), checked against input
  *schemas*; Google's read-only annotations "were not captured"; no preset has a fetch tool; no CRM, Slack, Drive or
  Outlook preset; OAuth and a token vault are "deliberately missing" (the tenant builds the directory).
- **Size:** [EST] days to weeks for a tenant, against the README's "five minutes" on static example files.
- **Consequences inside Eden:** without fetch tools every preset source stays on the daily sweep, doubted copies
  are delivered as held, and Q5's fix is unavailable.
- **Proposed:** run one consenting account through the Gmail and Calendar presets (docs/PILOT.md is built, not
  run), capture annotations and a fetch reply, then add verified fetch tools. Owner decision: real data.

#### D3. The one-line proxy delivers the push and nothing else

- **Evidence:** [N] INTEGRATION.md: the proxy adds no `ask_context` (D70: without it −11.9 points), cannot check a
  tool call, cannot forward change notices. The Responses route is "not yet checked against the real API", and with
  `previous_response_id` Eden sees no tool calls.
- **Proposed:** let the proxy inject the `ask_context` tool definition and answer its calls itself (it already
  rewrites the request). Measure with a Pi run through the proxy against the SDK arm. Verify the Responses route
  once with a real key.

#### D4. Six obligations, each with a measured penalty, and silence when one is missed

- **Evidence:** [N] INTEGRATION.md's loop: report every event; inject before every model call; keep packets in the
  transcript (+$0.057 per 1,000 and lost facts if not, D336); forward notices with refs (1 s a request if not);
  guard acting tools; send `session_start` at connect (−30 points at 10 s if not). The SDK fails open with no
  default logger, so a wrong key or id "looks like Eden's normal silence". The guide opens "advice, mostly
  unmeasured" and is 675 lines.
- **Proposed:** (1) a default `onError` that warns once. (2) `eden doctor`: reads a session's `explain` and the
  trace and names the obligations not met (no agent messages reported, bare signals sent, no `session_start`,
  packets not seen again in later requests). (3) One adapter that does all six for a common agent framework, as the
  Hermes plugin does. (4) Split the guide: a one-page loop, then the reference.

#### D5. Smaller items

- The Python client is synchronous: an asyncio agent blocks for up to 3.8 s unless it wraps every call [N].
- An MCP-only agent gets answers and no push [N].
- A deleted config key stops the server on upgrade ("unknown key"); a persist format bump re-syncs everyone [N].

### F. Developer experience: the repo's own loop

#### R1. The merge gate is slower than recorded and flaked on the first run

- **Evidence:** [M] 69.4 s (one timeout failure) and 64.1 s for the cold tests; about 90–95 s for the whole gate.
  `rare-terms.test.ts` "bounded…" took 7.3 s under four-way parallelism against a 5 s limit and 3.5 s alone.
  o2-dev-loop recorded another load-sensitive failure (`push-cut-behind.test.ts`).
- **Proposed:** run tests over 3 s alone in a serial tail, or give them explicit timeouts; add a "slowest ten and
  any test within 30% of its timeout" line to `scripts/test.sh`. Gain: a gate that does not need a re-run.

#### R2. The gate metric does not see the default's main path

- See B1 below. A change that moves packets on nothing-to-add requests from 81% to 98% reads as "no behaviour
  change" to `bun run eval`.

#### R3. The documents an agent must read no longer fit in a sitting

- **Evidence:** [M] DECISIONS.md is 706 KB (one row is up to 5 KB); engine CLAUDE.md 60 KB; `partner.ts` 7,022
  lines; 179 research notes; about 1,350 commits since 2026-10-19. CLAUDE.md asks every engine change to start by
  reading DECISIONS. Decisions carry "may collide, renumber on merge".
- **Drift found:** [M] `funnel --ask` does not exist; [M] partner.ts's size in CLAUDE.md is off by 1,900 lines;
  [C] ARCHITECTURE's diagram still routes through a graph deleted by D225.
- **Proposed:** a generated one-line-per-decision index with status (live, superseded, deleted) and a "dead ends by
  topic" page; split `partner.ts` along its paths (observe/push, ask, check, delivery); a doc test that runs every
  command CLAUDE.md names with `--help`.

#### R4. Paid runs are lost when the container restarts

- **Evidence:** [N] o1-earn ($2.50) and o4-new-user ($0.93): the fan-out and pi-ab write results only at the end.
- **Proposed:** append each task's result as it finishes; resume by task id.

### G. Agent experience

#### A1. The packet asks the agent to do Eden's job

- **Evidence:** [C] `render.ts:156–159`: "nothing has checked them against it. Before using one, check it is about
  the same person, thing and date … if it is not, ignore it and do not mention it." [M] 4.3–4.7 items a neutral
  request; the demo's first packet is one fact and four other invoices.
- **Risk:** it holds for Haiku, Sonnet and Opus 5.5 at small n. No other model family has been run on the current
  default; VISION names GLM 5.3 Flash. A model that follows "do not mention it" less well turns 98% packet coverage
  into false concerns.
- **Proposed:** a small agent-model matrix (two non-Anthropic models, 48 tasks each, hidden, control, neutral) with
  confirmed concerns as the readout. Needs the owner's key for another provider.

#### A2. Excerpts are cut at 320 bytes and the agent cannot ask for the rest

- **Evidence:** [C] `render.ts:67` (`itemBytes ?? 320`), lines end in "…". The only tool is a free-text question.
- **Proposed:** trial: an optional `item` argument on `ask_context` taking the id Eden already cites, returning that
  item's relevant parts in full. Measure on "in hand, not raised" tasks. Small.
- **Prior attempts:** `askMulti` (D485) and `+terse` (D335) changed the question's form, not this.

#### A3. Eden never learns that the agent's context was compacted

- **Evidence:** [C] `packages/protocol/src/types.ts:25–38`: seven event kinds, none for a context reset. The
  not-twice ledger is per session (D13). Not run; by reading.
- **Size:** unmeasured. For long-running agents that summarise their history, every fact Eden handed before the
  compaction is gone from the agent and will not be handed again in that session.
- **Proposed:** a `context_reset` event (or a `held` list on `observe`) that clears the session's shown marks.
  Test with a days run whose harness compacts at request 8.

#### A4. Anything Eden finds after the agent's first model call is lost in a one-request session

- **Evidence:** [N] follow-ups taken in 0 of 432 tasks (C4), 36 of 768 (D704), 12 of 216 with a 1.2 s wait (N3).
- **Proposed:** accept it; stop building follow-up paths. Where the integration can show a late packet to the
  *user* (a notification), expose pending packets on a webhook instead of to the agent. Product decision.
- **Prior attempts:** `takeSettleMs` (D515), `pushCheckBehind` and `+amend` (D704), `askBehind`'s packet.

#### A5. Packets inside the user's turn

- **Evidence:** [N] on the Messages route the packet is a text block of the user's own message (o2-proxy-messages).
  A mid-turn packet breaks the prompt cache unless appended at the end (INTEGRATION.md).
- **Proposed:** measure whether a model treats a packet in the user turn differently from a system message
  (confirmed concerns and facts raised, proxy arm against SDK arm). Unmeasured today.

---

## 3. Gaps in the benchmarks

| # | Gap | Evidence | What it hides | Fix |
| --- | --- | --- | --- | --- |
| B1 | The merge gate's `falseFireRate` does not count candidates on nothing-to-add requests; cards and intent are inert in it | [M] eval identical with `pushOpen` off; `inert` in its JSON | Q4, C1 | Add neutral acting requests to the eval's scenarios and report "packets on neutral turns" and "items a neutral turn" beside the three numbers |
| B2 | No real connector, no real data, ever | [N] LAB §8: the pilot is "built, not run"; presets checked on schemas | Every figure; Q5, D2, C2 | Run the pilot on one consenting account (owner) |
| B3 | No unread blind suite is left | [N] D802 | Any future default cannot be confirmed | Commission heldout19 before the next trial is promoted; by an author who has not seen the engine |
| B4 | Request wording is imperative English only | [M] 0 of 236 | Q6 | A reworded variant of train (needs, plans, questions; one non-English set) |
| B5 | Facts never sit in rarely used sources; noise connectors share a vocabulary unless `--noise-vocab` is passed | [N] o1-earn §2b, §3 | Dormancy, the earn rule's real recall cost at 1,000 sources | A "long tail" suite: one fact in a source used once |
| B6 | A simulated user holds every template's constraint and decoy at once (about 1,500 items, 3,000 cap) | [N] o3-pointer §3.1 | Whether Q1 is the product or the lab | Vary constraint density and world size (5,000–50,000 items) and re-read the pool diagnosis |
| B7 | The days horizon is 2–8 compressed days (36 hours), sessions reset daily, four to eight users in most runs | [N] D519: a do-nothing arm differed from its twin; o1-earn §3 | Weekly sweeps, drift, long-session cost, anything across days | Users as clusters with at least 24 users (as o1-earn's days check did); a real-time week at $0 |
| B8 | Intent coverage: seeds 41–44 replay an index about seven times fuller than the product builds | [N] D714, o3-pointer §3.2 | The level of every short figure on those seeds (61–67% against 51–55% on 45–48) | Report seeds 45+ as the headline; regenerate 41–44's caches through the shipped pipeline |
| B9 | One agent model (Haiku) for nearly every decision; two graders that disagree by 7 points on the same answers | [N] B18 §2; N4 | Q2, A1; rules passed or failed on the weaker agent | Sonnet as the agent for promotion runs; a hand-graded sample of 200 answers to calibrate the grader |
| B10 | The baseline is an agent with search tools (2–5% hidden). No "always inject the top five search hits" arm | I found none in LAB.md's conditions (`none, tools, eden, both`) | How much of +55 points is selection and how much is any retrieval | One arm: BM25 top five per request, no cards, intent or gate. VISION cites exactly this ablation in Meta's paper |
| B11 | Single runs: benches "one run each", funnel on seed 41 for many screens | Throughout | Small effects | Three runs for any bench figure quoted as a ratio under 1.3x |
| B12 | Prices: connector plans "list prices, assumed"; cache-read 0.05x "the brief's figure"; all on Anthropic-direct, not OpenRouter | [N] N4 §8, o1-earn | C2, C3 | Verify once; run D145's probe |
| B13 | The funnel always asks | [N] engine CLAUDE.md | Anything that moves a fact between push and ask | Already known; keep `pushHanded` as the funnel's headline |

---

## 4. Where the code or data contradicts the notes or the brief

1. **"The test suite takes about 55 s cold."** [M] 64–69 s for tests, about 90–95 s for the gate, and one of two
   cold runs failed on a timeout.
2. **"Silence by default" and `falseFireRate 0`.** [M] a packet goes on 95–98% of nothing-to-add requests. The metric
   is blind to it.
3. **CLAUDE.md's `bun run funnel … --ask`.** [M] rejected as an unknown flag.
4. **"Blind heldout18: Eden 49–59%."** The two ends are two graders on the same answers, not a range of outcomes.
   The wave's gain is established only on Sonnet's grade (+9.4, +1.6..+18.8); on Haiku's it is +2.3 (−5.5..+10.2).
   The days row is 9 against 7 of 16.
5. **"pushOpen +4.1 points."** That was measured with a looser gate than the one shipped (o3-push-open §5), half of
   it on seeds with the over-full intent index (+6.3 there, +2.0 on seeds 45–48), and B18 did not run the
   `minus-open` arm, so nothing blind attributes any gain to it.
6. **"About 66% one request a session."** 67.4% is `eden~O` on seeds 41–44 (replayed intent). Eight seeds read
   about 60%; seeds 45–48, the shipped coverage, 53.3% (o3-push-open §4).
7. **"Capacity about 3,460 users."** True of the bench at a quarter active with three sources a user. A
   1,000-source user is three to four times a bench user, and the quarter is a convention.
8. **o4-new-user's "five sources read in about 6.5 seconds"** was already corrected in the note to 7.8–17.3 s.
9. **Engine CLAUDE.md says the trials are decided by rules "applied mechanically".** `pushOpen` failed its
   registered days clause (D707), the clause was replaced (D709), and it then passed (D710). The reasoning is
   recorded and defensible, but it is a rule changed after a result.

---

## 5. Ranking (impact ÷ effort) and plan

Impact and effort are my judgement [EST]. "Suite first" means the lab cannot decide it today.

| Rank | Item | Impact | Effort | Needs |
| --- | --- | --- | --- | --- |
| 1 | B1: neutral requests in the eval; packets-per-neutral-turn as a gate number | Makes Q4/C1 visible on every merge | Hours | Nothing |
| 2 | R1: de-flake and time the cold gate | Every merge | Hours | Nothing |
| 3 | Q4.1: the owner's decision on the push check (arm K or N) | +2.7 to +7.9 points; neutral packets 98% → about 10%; cuts C1 | Decision, then a blind run | Owner; B3 |
| 4 | B9 + Q2: one Sonnet-as-agent run of the default | Decides whether Q2 exists and whether Haiku-set bounds are right | About $5 | Budget |
| 5 | B10: the top-five-injection baseline arm | Says what Eden's selection is worth | About $1 | Budget |
| 6 | Q6: indirect and non-English requests | Unknown; could match `pushOpen`'s +4 | Days | B4 suite first |
| 7 | Q5: re-read held items from quiet sources | 67% → about 90% of owed updates [EST] | Days | D2 (fetch tools); owner on calls |
| 8 | B3: write heldout19 | Unblocks every promotion | A day, another author | Owner |
| 9 | D4: default `onError`, `eden doctor` | Removes silent misintegration | Days | Nothing |
| 10 | D3: `ask_context` through the proxy | +12 points for proxy users (D70's figure) | Days | A Pi-through-proxy run |
| 11 | Q1.1: alias table | +3 to +6 on anchored requests | A week | B6 screen first |
| 12 | SC1.1: merge the delta tier when idle | About 0.4 MB a user | A day | Nothing |
| 13 | S2: fast thaw, then freeze sooner | 1.5–2x users a box if the active share falls | A week | Trace of a real fleet |
| 14 | C2.4: decide `syncSweepSpread` before 2026-11-18 | Trial hygiene; rate limits | Hours | Owner |
| 15 | A3: `context_reset` | Unknown; correctness for compacting agents | Days | A days harness that compacts |
| 16 | D2 + B2: the real-data pilot | Validates everything | Days | Owner (consent, data) |
| 17 | Q3: pointer on the new default | Up to +7, likely +2 | $7 | Budget |
| 18 | R3: decision index, split `partner.ts`, doc test | Loop speed for every session | Days | Nothing |
| 19 | Q7, Q8, S3, SC2, D1 | As described | Varies | Owner for D1, S3 |

**Order of work.**

- *First, in parallel, no owner input:* ranks 1, 2, 9, 12, 18, and R4. They change no behaviour the lab scores.
- *At the same time, $0 lab work:* the B4 reworded suite, the B6 density screen, the B5 long-tail suite.
- *Needs a new suite before any live run:* Q6 (B4), Q1 (B6), dormant sources (B5), any promotion at all (B3).
- *Small paid runs, independent of each other:* ranks 4, 5, 17 (about $13 in all [EST]).
- *Blocked on the owner:* ranks 3, 7, 8, 14, 16.

---

## 6. Decisions only the owner can make

1. **The push check.** Accept +$0.04–0.21 per 1,000 tasks and +0.3–1.06 s for +2.7–7.9 points and far fewer
   packets, or delete the six `pushCheck*` switches at their end date (2026-12-10).
2. **"Silence by default".** Keep the rule and narrow the default, or amend the rule to match what ships.
3. **Real data.** Run the pilot on a consenting account; verify real Gmail and Calendar connectors.
4. **A new blind suite** and who writes it.
5. **Persistence on by default** (item content on disk, D8) for restarts.
6. **Connector calls against freshness** for sources that send no notice (Q5), and whether never-used sources are
   held at all (dormancy).
7. **A tenant-level prior** for new users (crosses D9).
8. **Which agent models and languages Eden targets**; this sets the benchmark's agent and the gate's lexicons.
9. **Publishing** the clients and an image.
10. **Trials near their date:** `syncSweepSpread` (2026-11-18); `actionCheck`, `guardLine`,
    `quarantineInstructions`, tsgo, the OpenRouter cache probe (2026-12-03).
