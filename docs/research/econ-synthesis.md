# Econ synthesis and pre-registered blind evaluation

Status: 2026-10-31. Written by the synthesis agent before any blind run (section 4 is the pre-registration); committed unchanged before the blind runs. Results are appended below after the runs, without changing sections 0-4.


All seven tracks are in-sample only. None has run held-out suites 5–9, so every gain below is an estimate until the blind run in section 4 is done. I changed no code.

Where my numbers come from:
- **Trial merges:** I merged every pair of branches in a throwaway worktree, then removed it. The conflict table in section 2 comes from that.
- **Per-run costs:** taken from D64's `bench/pi-*.json`.
- **Everything else:** quoted from the track reports or read from the branches.

There is one prerequisite that no track mentioned. **`hidden-heldout9.ts` exists but is not registered in `packages/sim/src/lab/suites.ts`**, so suites 5–9 cannot be run today. It has 28 templates and has never been run. Registering it is one import and one map entry, and nobody should read its templates first.

## 0. Evidence quality by track

| Track | Strongest evidence | Weaknesses | Grade |
|---|---|---|---|
| **judge** (`syncPollBehind`, `judgeBehind`) | **`syncPollBehind`:**<ul><li>no-model funnel identical task by task at both time scales;</li><li>live, Eden's critical path −426 ms (−526..−347);</li><li>mechanism confirmed by the spans (the `sync.freshen` wait was 503 ms p50).</li></ul> | <ul><li>The follow-up lookup never ran in any benchmark, because the worlds are static. Only unit tests cover it.</li><li>`judgeBehind`: +0.085 hidden (−0.014..+0.183), n=71, one seed.</li><li>`judgeBehind` raises funnel decoys from 4 to 36 of 67.</li><li>17 of 105 queued items arrived after the agent's final answer.</li><li>The budget cap cut the live run unevenly across conditions.</li></ul> | `syncPollBehind`: strong for time. `judgeBehind`: weak and promising. |
| **decide** (`decideConflict`, `decide`) | <ul><li>No model, deterministic: 218→225 planted, decoys 18→18.</li><li>Paired +0.026 (+0.007..+0.045).</li><li>Gains spread over 3 suites and 5 templates.</li><li>Sim precision up, false fires unchanged.</li></ul> | <ul><li>Bootstrap is over tasks, but gains cluster by template, so the interval is optimistic.</li><li>The blind gap is mostly the reading kind, which this does not touch.</li><li>`decide` (the logistic model) adds +0.004 and cannot gate the fallback.</li></ul> | `decideConflict`: moderate and low-risk. `decide`: not useful. |
| **uptake** (`packetVerdicts`) | <ul><li>A manual read of the 29 misses found a real Eden bug: compaction drops the year, and calendar holds that keep their time only in `meta.start` lose their day.</li><li>Facts that state a year: 0.64→0.96.</li><li>Deliveries identical with the flag on.</li></ul> | <ul><li>Overall +0.038 strict (−0.011..+0.083); the lenient grader shows +0.000.</li><li>The gain is mostly strict-grader form.</li><li>Verdict tags were neutral (0.91 vs 0.91) and could make a co-delivered noise item look important.</li></ul> | Date fix: moderate (it is a bug fix). Tags: no evidence. |
| **econ-background** (`cardsEconomy`, price routing, `syncPush`) | <ul><li>`cardsEconomy` matches the baseline on all 536 tasks, and on items aged 45 days.</li><li>Items carded per user −57.8%, calls −49.9%.</li></ul> | <ul><li>Price routing: −41% is pooled, not paired, one run per configuration.</li><li>The fp4 endpoint truncates batches: coverage 617/657 against 637.</li><li>The `FOOTER` regex cuts to the end of a message.</li><li>`syncPush`: +2 decoys of 268; no server route yet.</li><li>The −75% card cost is arithmetic, not a live run.</li></ul> | `cardsEconomy`: strong (in-sample). Price routing: moderate. `syncPush`: design-level evidence only. |
| **firewall** (`actionCheck`) | <ul><li>Beside a tools-only agent (seed 45, fresh): unsafe actions 0.269→0.134 (−0.254..−0.015), raised +0.134, 0/67 control tasks flagged.</li><li>No model, 3–5 ms per check.</li></ul> | <ul><li>v3 was tuned after reading seeds 41–42; fresh confirmation is one seed per setting.</li><li>Beside ALL, the firewall's own effect is about +1 task in 134. The rest is agent variance.</li><li>Lexicons were tuned on the simulated suites.</li><li>"Raised" stands in for "safe".</li></ul> | Moderate for tool-acting agents; weak beside ALL. |
| **oneturn** (`packetAlso`) | <ul><li>4 seeds, paired.</li><li>A clean negative: keeping the ask gives +0.000 (−0.049..+0.050).</li><li>Removing the ask loses −0.119 (−0.196..−0.047).</li><li>Explains D64's "did not ask" advantage as selection.</li></ul> | <ul><li>The "only in also-found" slice is n=10.</li><li>Wall times are noisy: conditions ran concurrently on 4 CPUs.</li></ul> | Strong negative. |
| **econ-research** | <ul><li>Routing confound: up to 10× endpoint price spread, and an endpoint mix that changes with the condition.</li><li>Request time = 743 ms + 7.7 ms per output token; input size does not matter.</li><li>Cost-sensitive threshold arithmetic.</li></ul> | <ul><li>Observational.</li><li>R1 (pre-executed ask) and R2 (lower thresholds) are untested.</li><li>oneturn's no-ask and also-found results argue against both.</li></ul> | Good for how we measure; its recommendations are only hypotheses. |

**Cross-track lesson.** Three tracks tried to get more facts by showing the agent more candidates: oneturn's also-found section, `decide` ordering a list for the agent to judge, and research R2's lower thresholds. All three hit the same wall: candidates the gate holds back are rarely used and sometimes mislead. The facts lever that held up was making Eden's existing verdicts reach the packet (`decideConflict`) and stating dates exactly (the uptake date fix). Time and cost levers held up where they leave the agent's behaviour alone: polling behind the lookup, carding fewer items, and price-routing the card maker.

## 1. What to adopt, ranked

| # | Adopt | Flag | Priority it serves | Expected effect (in-sample, if it holds blind) |
|---|---|---|---|---|
| 1 | Poll behind the lookup | `syncPollBehind: true` | Time | Eden's critical path ~530 → ~80 ms; wall p50 about −0.4..−0.6 s (8.55 → ~8.0 s). Facts and false concerns unchanged. $0. |
| 2 | Deliver a found conflict whatever path spoke first | `decideConflict: true` | Facts | Delivered +0.026 → raised about +0.013 per hidden task in-sample; blind likely +0.00..+0.01. Decoys unchanged. +1.6 ms CPU off the critical path. |
| 3 | Card economy plus price-routed card maker | `cardsEconomy: true`, card maker `sort: "price"` | Cost | Card backfill $0.0041 → ~$0.0010 per user. D64 card share $0.156 → ~$0.039 per 1k tasks, so ALL all-in ~$0.474 → ~$0.36 per 1k (estimate). Facts unchanged. Needs one fix first (below). |
| 4 | Packet dates: keep the year, add "Starts: …" for events whose text never names their day | New `packetDates: true`, split out of `packetVerdicts` | Facts and precision | Strict +0.02..+0.04, mostly facts stating a year; lenient ~0. About +10 tokens per packet. |
| 5 | Action firewall as an opt-in integration (`POST /v1/check`, `client.check`) | `actionCheck: true` where the tenant integrates it | Facts and safety for tool-acting agents | Beside tools only: unsafe −0.13, raised +0.13 (one seed). Beside ALL: about +1–3 facts per 134. No model call. |
| 6 | Push freshness as an opt-in API | `syncPush: true` (needs a tenant relay; webhook route is a follow-up) | Time and production freshness | Request-time listing calls 5.55 → 0 per task in the funnel; deletes propagate at once. +2/268 decoys in-sample. Not measurable in pi-ab. |
| 7 | Report cost re-priced at a fixed endpoint beside billed (research R3) | Lab only | Honest cost | At fixed prices Eden's agent costs 20–23% less than tools; billed numbers hide this. |
| 8 | Tenant guidance doc (research R10) | Docs only | Cost and time for tenants | Keep `ask_context`; concise answers (output tokens are 85% of model time); byte-stable packet after the stable prefix; per-user `session_id`. Unmeasured, so labelled as advice. |

**The new recommended configuration (call it `ALL2`).** It is `ALL.cfg` plus the flags below. It contains no model judge, so per request it makes no Eden model call, the same as ALL.

```json
{ ...ALL, "syncPollBehind": true, "decideConflict": true, "cardsEconomy": true, "packetDates": true }
```

The card maker runs with `sort: "price"`. Integrations that let the agent act add `actionCheck: true`, and integrations that can relay change notices add `syncPush: true`.

**Run on the blind suites but kept out of `ALL2`:** `judgeBehind`. It is the only candidate with a large facts gain (+0.07..+0.09), but its interval includes zero, it multiplies funnel decoys by 9, and its items sometimes arrive late. Adopt it only if the blind run meets the bar in section 4.

**Rejected or dropped:**
- **`packetAlso` (oneturn):** rejected. Do not merge the engine code, `Injection.also` or the client guidance strings. Record the result as a decision: keep `ask_context`.
- **`decide`** (logistic gate, `DECIDE_MODEL`, `decideThreshold`, `decideModel`): drop from the engine. Its +0.004 is not worth the code in `partner.ts`, and its proposed use, ordering an also-found list, died with oneturn. Keep `Facts`, `onCandidates`, `--candidates` and `decide-fit.ts` as lab instruments for future gate research.
- **Verdict tags (`packetVerdicts` beyond dates):** keep the code behind its flag, off, or drop it. Measured neutral, with a salience risk. If kept, the firewall's finding text can share the `itemTag` vocabulary.
- **Model judge on the critical path:** stays off, as in D64.
- **Research R1 (pre-executed ask) and R4 (coverage line):** not adopted. oneturn showed the agent's own ask adds facts even when the packet already holds the fact (0.913 vs 0.837). The coverage line alone measured −0.037 hidden (CI includes 0).
- **Research R2 (lower thresholds from uptake):** not adopted. oneturn and `decide` both showed held-back candidates convert poorly. Future work only: supersession on graph edges (R8) first, then a cost-sensitive gate.
- **Also not taken (background track):** lazy carding, cheaper card models, `maxPrice`, lean prompt, reasoning off, batch 50.

**Combined expected impact, `ALL2` against ALL (estimates, to be replaced by blind numbers):**

| Priority | Expected change |
|---|---|
| Facts (blind hidden raised, from 0.538) | +0.00..+0.03; +0.07 more if `judgeBehind` holds |
| All-in cost ($/1k tasks) | ~0.474 → ~0.36; agent cost unchanged |
| Wall p50 | −0.4..−0.6 s |
| False concerns (from 0.019) | Unchanged within ±0.01 |

## 2. Interactions and conflicts

**Textual conflicts.** Each branch's own D65 row conflicts with every other branch in `docs/DECISIONS.md`. Every other pair merged cleanly except these:

| Pair | Conflicting files (hunks) |
|---|---|
| background + judge | `sync.ts` (1) |
| background + decide | `config.ts` (1) |
| background + uptake | `hidden-funnel.ts` (1) |
| background + oneturn | `config.ts` (1) |
| decide + judge | `partner.ts` (2) |
| decide + firewall | `partner.ts` (1) |
| decide + uptake | `hidden-funnel.ts` (3) |
| decide + oneturn | `config.ts` (2), `partner.ts` (3) |
| judge + uptake | `pi-ab.ts` (4) |
| judge + oneturn | `partner.ts` (1), `pi-ab.ts` (3) |
| firewall + judge | `partner.ts` (1), `pi-ab.ts` (4) |
| firewall + uptake | `ab-common.ts` (2), `pi-ab.ts` (5) |
| firewall + oneturn | `client/index.ts` (1), `ab-common.ts` (1), `pi-ab.ts` (7) |
| oneturn + uptake | `partner.ts` (1), `pi-ab.ts` (2) |

**Semantic interactions to test after merging:**
- **`syncPollBehind` with `decideConflict` (`partner.ts`).** The follow-up lookup after a poll that stored something "adds only sure or grounded items". It must also run the `decideConflict` pass. Otherwise a fresh item that conflicts with the request arrives only through `ask_context`. Add a test.
- **`syncPollBehind` with `syncPush` (`sync.ts`).** A confirmed pushed source counts as current, so there is no poll. Poll-behind applies only to sources that are not pushed. Add a test with both on, including a lapsed watch: after `syncPushMaxStaleMs` the source should fall back to poll-behind, not to an on-path poll.
- **`syncPush` changes D57's freshness rule** (`readAt` treats items from a pushed source as read now). Fold this into the new decision row, not a silent change.
- **`cardsEconomy` with `decideConflict`.** `decideConflict` uses card verdicts, and fewer items are carded (2,349 of 2,530 constraint cards kept). Re-run the in-sample funnel with both; expect about 225/18 and investigate any change.
- **`decideConflict` with the firewall.** decide refactored the grounded conflict block into `conflicts()`; firewall edits `conflict.ts` and calls `grounded` with the ledger ignored. Merge so that `checkAction` uses the same `conflicts()` helper rather than a second copy.
- **`judgeBehind` with `decideConflict`.** The judge reads "candidates the no-model decision left out", so after `decideConflict` it sees one fewer candidate. That is fine, but use the merged code when measuring.
- **`packetDates` and compaction.** The year has to survive `compactInjection`/`densePacket` too, not just `render.ts`. Uptake's tests cover render. Add one test through `partner.ts` with ALL's packet flags on.
- **Lab tooling has four versions of one idea.** Cards replay: oneturn `--cards-file`, uptake `--cards-file`, judge `--cards`, firewall `--cards-disk`. Conditions: oneturn `eden-1t[.iXbY]`, uptake `eden+flag`, judge `eden~name` with `--variant-config`, firewall `--act` with `*-act*`. Packet recording in the timeline: oneturn and uptake.
  - Keep judge's `--variant-config` and `eden~name` as the general form, with uptake's `eden+flag` as shorthand.
  - Keep one cards replay flag, `--cards` (judge), and make `--cards-disk` an alias. Take care of the mutation bug oneturn hit: a replay file mutated during a run. Open the replay file read-only and write new cards to a separate file.
  - Keep one packet-recording path: uptake's, which also records cited ids and planted ids.
  - Keep `--act` as a mode (it changes the system prompt and tools).
- **Render formats.** Only `render.ts` from uptake (dates, and tags behind the flag) and the firewall's finding text remain. With oneturn's `renderAlso` dropped, `itemTag` has no second user unless the firewall's finding adopts it.

## 3. Integration plan

One change per PR, as CLAUDE.md requires. Branch each from up-to-date `main`. Run `bun run check` and the no-model `bun run eval` on every final tree, and the `reviewer` subagent on every engine, server or privacy PR; no track ran it. Merge order goes from least conflict-prone to most, with the base for the eval conditions first:

1. **PR 1, lab base (no engine change).**
   - Register `heldout9` in `SUITES` (import plus map entry, templates unread).
   - Unify pi-ab:
     - `--variant-config` and `eden~name`, with the `eden+flag` shorthand;
     - a single read-only `--cards` replay (`--cards-disk` as an alias);
     - uptake's packet, cited-id and planted-id recording.
   - Add `hidden-funnel` waiting for work left behind a lookup, polls counted by the sync's own count, `--packets` and `--candidates`.
   - Add econ-research's `normcost.py`/`routes.py` re-pricing to the report step, plus `act-report.ts` and `firewall-replay.ts`.
   - Remove nothing.
2. **PR 2, judge** (`syncPollBehind`, `judgeBehind`, `sync.ts`).
   - Add one dynamic-world test the track lacked: an item arrives during the background poll and must reach the follow-up delivery, not only `ask_context`.
   - Docs: decision D65 ("no judge on the critical path; poll behind the lookup"), a COST-MODEL row, and ARCHITECTURE (the critical path now has no source call when sync is current or polling behind).
3. **PR 3, background** (`cardsEconomy`, sentence reuse, OpenRouter `sort`, `syncPush`).
   - Resolve `sync.ts` against PR 2, then add the push plus poll-behind test.
   - Two fixes before merge:
     - limit the `FOOTER` cut to the footer block instead of the end of the message, with a test where a constraint follows a disclaimer;
     - retry truncated card batches (or re-send their items) with default routing, so price routing does not lose coverage (617 vs 637).
   - Drop `maxPrice` and the lean/reasoning/maxTokens card-maker options, or leave them undocumented as lab-only; nothing recommends them.
   - Keep `econ-price20-v2.jsonl` (cards for the `ALL2` funnel and replay) and drop `econ-default20-v2.jsonl` unless something cites it.
   - Docs: D66, COST-MODEL card share, ARCHITECTURE push. The webhook server route is a follow-up PR (server, so it needs a reviewer).
4. **PR 4, decide** (`decideConflict`, `conflicts()` refactor, `onCandidates`, `Facts`).
   - Remove the `decide`, `decideThreshold` and `decideModel` flags and `DECIDE_MODEL` from the engine; keep the lab fit script.
   - Resolve `partner.ts` against PR 2 and make the follow-up lookup run the conflict pass (test).
   - Re-run the in-sample funnel with `cardsEconomy`.
   - Docs: D67.
5. **PR 5, packet dates.** Take uptake's year-keeping and "Starts:" changes as their own `packetDates` flag. Leave verdict tags behind `packetVerdicts`, off, or drop them; reviewer's call on dead-code weight. Docs: D68.
6. **PR 6, firewall** (`actionCheck`, `firewall.ts`, protocol `ActionCheck`, `POST /v1/check`, `client.check`, `heldResult`).
   - Point it at the shared `conflicts()` from PR 4.
   - Reviewer pass for privacy. Tool arguments are user data: confirm they pass `sanitizeForStore` before any log or store, and confirm the route returns 4xx for bad input and 503 for internal failure.
   - Drop WIP commit `7b435dba7` from history, or squash it (the doc cites it, so cite the doc's numbers instead).
   - Docs: D69, ARCHITECTURE, COST-MODEL.
7. **PR 7, docs only.**
   - Bring in oneturn's and econ-research's research notes (`econ-oneturn.md`, `econ-research.md`, the research scripts). Leave out oneturn's engine, protocol, client and pi-ab `eden-1t*` code.
   - D70: one-turn packets rejected; tenants keep `ask_context`.
   - D71: cost reported billed and re-priced at a fixed endpoint; the cost-sensitive gate is future work behind supersession.
   - Add a tenant integration guide (R10, labelled as unmeasured advice).
8. **PR 8, after the blind run.**
   - `docs/research/econ-synthesis.md` with the blind results.
   - D72: the `ALL2` recommended configuration, with or without `judgeBehind` depending on its bar.
   - VISION/ARCHITECTURE wording if the recommended default changes.
   - Also `bun run eval --live` (scoring and delivery changed); report both runs.

**Renumbering.** All seven branches claim "D65". Renumber in merge order as above, D65–D71, with D72 for the post-blind configuration decision. Each row records its in-sample numbers and is updated with blind numbers in PR 8.

## 4. Final evaluation protocol

**Pre-register before the run.** Commit to `docs/research/econ-synthesis.md` the conditions, metrics and pass bars below, run the blind suites once, and do no tuning afterwards. Done in order:

1. Register `heldout9` unread.
2. **No-model funnel, $0.** `hidden-funnel.ts --suite heldout5,heldout6,heldout7,heldout8,heldout9 --seeds 41,42,43,44 --cards …` for ALL, `ALL2`, and `ALL2` with each new flag removed in turn (leave-one-out). Report delivered and decoys per path for hidden and control, packet bytes, and request-time calls. This is the blind check of `decideConflict`, `cardsEconomy` and `packetDates`, separate from agent variance.
3. **Live run, pi-ab on the Pi harness.** Agent `z-ai/glm-5.3-flash`, grader `deepseek/deepseek-v4.1-flash`, `--time-scale 1`, suites heldout5–9, seeds 41–44.
   - One process per seed per mode, seeds run one after another. Conditions run concurrently within a process, as in D64, so wall comparisons are paired under the same load.
   - Cards: replayed from disk where covered and enriched live (with spend counted) where not. ALL uses D59 cards and default routing; `ALL2` uses economy cards and price routing.

**Conditions** (the blind suites are 107 templates × 2 variants = 214 tasks per seed per condition, so 856 per condition over 4 seeds):

| Process | Condition | Purpose |
|---|---|---|
| main | `tools` | D64 baseline, re-run under the same harness version |
| main | `eden` (ALL) | D64 recommended configuration |
| main | `eden~ALL2` | New recommended configuration |
| main | `eden~ALL2jb` (`ALL2` plus `judgeBehind`) | Optional add-on |
| act (`--act`) | `tools-act` | Agent acting through its own tools |
| act (`--act`) | `tools-act-firewall` | Firewall beside a tools-only agent (the track's strongest claim) |

**Expected live spend.** Per-run costs come from D64's files (this session): eden ALL agent ≈ $0.30–0.35 per 1k runs, tools ≈ $0.30–0.35, grader ≈ $0.167 per 1k runs. The act-mode cost comes from the firewall track: $0.57 per 1k hidden runs.

| Item | Runs | $/run | Estimate | Hard cap |
|---|---|---|---|---|
| tools | 856 | 0.00049 | $0.42 | – |
| eden ALL | 856 | 0.00048 | $0.41 | – |
| eden~ALL2 | 856 | 0.00048 | $0.41 | – |
| eden~ALL2jb (+0.9 judge calls × $0.000024) | 856 | 0.00050 | $0.43 | – |
| Main process subtotal | | | $1.67 | 4 × $0.48 = $1.92 |
| tools-act | 856 | 0.00077 | $0.66 | – |
| tools-act-firewall (held calls add a request) | 856 | 0.00079 | $0.68 | – |
| Act process subtotal | | | $1.34 | 4 × $0.38 = $1.52 |
| Live card enrichment for uncovered blind items (both card sets) | – | – | ≤ $0.20 | $0.25 (`cards-enrich --cap`) |
| Lenient second grade, hidden answers of eden and eden~ALL2 | 856 | 0.000167 | $0.14 | $0.15 |
| `bun run eval --live` | – | – | < $0.01 | – |
| **Total** | | | **≈ $3.36** | **$3.84 < $4.00** |

Caps sit about 15% above the estimates, because a worst-case hold refused a run in oneturn and a cap cut judge's run unevenly. If spend runs over, cut in this order: `eden~ALL2jb` first, then the lenient regrade.

**Metrics.** Report all of the following per condition, with paired differences against `eden` (and `tools-act` for the act pair):
- **Bootstrap intervals:** paired, 95%, 2,000 resamples, over tasks and also over templates (cluster bootstrap); decide showed that gains cluster by template.
- **Facts:**
  - hidden raised, strict, plus lenient on the regraded subset;
  - uptake: P(raised | delivered) and P(raised | not delivered);
  - delivered and decoy rates per delivery path (join with the funnel's per-task output);
  - per suite, with heldout9 shown separately as fully fresh.
- **False concerns:** the control false-concern rate; for the act pair, also control tasks flagged, unsafe, executed and overrode.
- **Cost:**
  - agent and Eden model $/1k as billed, and re-priced at one fixed endpoint (Wafer-us and Z.AI list, `normcost.py`); report the endpoint mix per condition;
  - card backfill $ per user, and $/1k at D64's accounting, measured from this run's enrichment spend;
  - grader cost shown separately, never in all-in;
  - input and output tokens, and model calls per task;
  - asked rate.
- **Time:** wall p50/p90/p99 and mean. Then account for every second on the critical path of every task from the timelines, as D64 did:
  - agent model time, split into per-call TTFT, generation and output tokens;
  - Eden time: the first observe's wait, `sync.freshen` on path versus behind, `eden.slow`, `eden.source`, `ask_context` latency, and late or queued items, including items queued after the final answer under `judgeBehind`;
  - tool execution, including firewall check ms and the extra time on held calls;
  - harness overhead.

  The parts must add up to the wall time, and the report shows the share each part takes. Also break wall time and cost down by asked versus not asked.

**Pass bars** (pre-registered):

- **`ALL2` replaces ALL** if all of these hold:
  - hidden raised is no worse: the lower CI bound of `ALL2` − ALL is above −0.03;
  - false concerns do not rise meaningfully: point estimate ≤ +0.01 and upper CI bound < +0.03, by both task and template bootstrap;
  - Eden's critical-path p50 is ≤ 150 ms;
  - all-in $/1k is lower.

  If not, adopt only the flags whose leave-one-out funnel and live results pass.
- **`judgeBehind` is added to `ALL2`** only if:
  - hidden `ALL2jb` − `ALL2` is ≥ +0.03, with the template-bootstrap lower bound above 0;
  - false concerns rise by ≤ +0.01;
  - fewer than 10% of tasks have items queued after the final answer.
- **Firewall is recommended for tool-acting integrations** if:
  - unsafe falls, with the upper CI bound below 0;
  - control tasks flagged stay ≤ 0.05;
  - false concerns rise by ≤ +0.01.

  It stays opt-in either way.
- **Bar 1 recheck:** report `ALL2` against tools as a ratio on the blind suites, beside D64's 2.0×.

All run outputs go under the session scratchpad (`bench-econ/`), with the commands written verbatim into the synthesis doc.

## Results of the pre-registered blind evaluation (appended after the runs; sections 0–4 unchanged)

Run 2026-10-31 on the merged tree (`6ff5e821e`, which carries the final review's firewall fixes; ledger labels
`econ-blind-main` and `econ-blind-act`).
- **Suites:** held-out 5–9 (held-out 9 run here for the first time), seeds 41–44, Pi harness. 428 hidden and 428
  control tasks per condition.
- **Live spend:** $3.10 (main $1.91, act $1.18).

**Deviations from section 4:**
- One card routing per process (`--card-sort price`), so ALL and ALL2 both used price-routed live cards. ALL's card
  cost is therefore lower than in D64.
- The lenient regrade was not run.

### No-model funnel (blind, $0)

| Configuration | Delivered / decoys of 428 | Request-time calls per task |
|---|---|---|
| ALL (cards-v2 replay) | 166 / 52 | 3.26 |
| ALL2 (cards-v2 replay) | 168 / 52 | 0.38 |
| ALL2 (price-routed replay file) | 145 / 50 | 0.38 |

- Leave-one-out (price file): 143–145.
- The 145 is a confound, not a flag: the price-routed replay file covered fewer blind items (852 uncovered against 246).
  On the same card file ALL2 equals ALL.

### Live (main process)

| Condition | Hidden raised | False concern | Billed $/1k (hidden) | Wall p50 (hidden) | Eden on critical path |
|---|---|---|---|---|---|
| tools | 0.271 | 0.009 | 0.354 | 8.40 s | 0 ms |
| eden (ALL) | **0.514** | 0.012 | 0.320 | 6.93 s | 528 ms (7%) |
| eden~ALL2 | 0.472 | 0.005 | 0.337 | 6.65 s | **76 ms (1%)** |
| eden~ALL2jb | 0.491 | 0.007 | 0.325 | 6.33 s | 73 ms (1%) |

Paired differences (task bootstrap):

| Comparison | Hidden raised | Wall | $/1k |
|---|---|---|---|
| ALL − tools | +0.243 (+0.192..+0.294) | −0.91 s | −$0.033 |
| ALL2 − ALL | −0.042 (−0.082..−0.002) | −0.16 s (−0.79..+0.48) | +$0.017 |
| ALL2jb − ALL | −0.023 (−0.058..+0.012) | −0.57 s (−1.02..−0.12) | |

The ALL2 − ALL false-concern difference was −0.007.

Agent cost re-priced at fixed endpoint prices (per 1k tasks, all tasks):

| Condition | Wafer-us | Z.AI list |
|---|---|---|
| tools | $0.319 | $0.697 |
| ALL | $0.272 | $0.665 |
| ALL2 | $0.275 | $0.676 |

Eden's own model spend (live cards plus the background judge) was $0.093 across 2,568 Eden runs, $0.036 per 1k.

Per second of task time:
- In ALL, Eden holds 444 ms of second 0.
- In ALL2 it holds 29 ms: the first packet no longer waits on the sync's poll. Eden also holds under 3% of every later
  second.

Uptake (planted item in a packet / only in an ask answer / neither):

| | Packet | Ask only | Neither |
|---|---|---|---|
| ALL | 152 (0.849 raised) | 100 (0.910) | 176 |
| ALL2 | 152 (0.822) | 84 (0.917) | 192 |

The drop is all in the ask path.

The ask path, diagnosed after the run with `hidden-funnel --ask` (Eden asked the request's own text, no model):

| Suites | ALL: delivered / ask cites planted | ALL2: delivered / ask cites planted |
|---|---|---|
| Blind | 162 / 189 | 164 / 189 |
| In-sample | 218 / 191 | 225 / 191 |

No single flag left out changes ask's citations (in-sample). Eden's ask answers are the same under both, so the live
ask-path difference is most likely the agent's own asking: what it asks, and whether it asks. No change was made in
response.

### Live (act process: a tools-only agent that can act, with and without the firewall)

Paired, firewall − none:

| Measure | Difference (95% CI) | Rate without → with the firewall |
|---|---|---|
| Hidden unsafe | −0.047 (−0.086..−0.009) | 0.350 → 0.304 |
| Hidden raised | +0.049 (+0.014..+0.084) | |
| Control flagged | +0.070 (+0.047..+0.096) | |
| Control false concern | +0.000 | |

Cost and wall time were unchanged within noise. The median check took 4.5 ms.

### Against the pre-registered bars

| Candidate | Bar | Result | Outcome |
|---|---|---|---|
| ALL2 replaces ALL | Hidden lower bound > −0.03; false concerns ≤ +0.01; Eden critical path ≤ 150 ms; cost lower | −0.082 lower bound (fails); −0.007 (passes); 76 ms (passes); +$0.017 billed (fails) | **Not adopted** |
| `judgeBehind` added | ≥ +0.03 over ALL2 with lower bound > 0 | +0.019 point | **Not adopted** |
| Firewall recommended for acting agents | Unsafe upper bound < 0; flagged ≤ 0.05; false concerns ≤ +0.01 | −0.009 (passes); 0.070 (fails); +0.000 (passes) | **Stays opt-in, not recommended** |
| Bar 1 recheck | ALL vs tools on the blind suites | 1.90× (0.514 / 0.271), held-out 9 included | Holds (D64 gave 2.0× without held-out 9) |

The flags stay off by default, and ALL remains the recommended configuration (D72).

Two things are left for a fresh pre-registered run, not this one:
- `syncPollBehind` on its own: its time gain is clear, and nothing in Eden's no-model behaviour changes with it.
- A firewall tuned for fewer flags on control tasks.
