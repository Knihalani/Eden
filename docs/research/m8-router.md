# M8: a connector router that predicts which sources hold what a request needs

Status: 2026-11-11, branch `claude/m8-router`, session M8 (decisions D940–D949). Train suites, M2's synthetic worlds
and P7's long tail only; heldout19 was never read or run. Anthropic cap $10, Modal cap $40. Every number below comes
from a command run in this session; **[EST]** marks arithmetic or judgement.

## In plain words

- **The problem.** A user connects many sources (about 1,000 in the lab's scale runs: mail, calendar, documents,
  chat, CRM, eight rarely used apps and 995 unrelated connectors). Each live read of a connector is what a tenant pays
  a connector platform for. Eden already learns which sources earn their reads (`sourceYield`, D505–D603), but every
  request still read about 5.3 connectors live at request time, mostly the user's mailbox (whose copy the user's cap
  cuts) and connectors that a name or a word pointed to.
- **What M8 built.** A tiny router (`routerGate`, `packages/engine/src/router.ts`): for each request and each of the
  user's sources, a probability that the source holds what the request needs, from the request's words against the
  source's kind and description (an int8 table of hashed word × source-key weights, 256 KB) and the evidence Eden
  already holds per user (the source's items among the request's best local matches and the place of its best one,
  its vocabulary sketch, names, rare words, whether its items were used and how often its reads went unused, whether
  its copy is whole), through a 16-unit network with a "nothing needed" option. A source under a fitted floor gets
  no live read for that request (it joins `sourceYield`'s spent copies), except a source a rare word of the request
  points to, which is always read.
- **What it did.** At 1,000 sources over four weeks, request-time connector calls fell 31% (the aim was 40%) with
  hidden facts, rare-connector facts and look-alikes level. With the router, sources it has not found likely for 28
  days are swept every 28 days instead of weekly: steady calls (request-time plus background) fell 70–73% on fresh
  users, facts level. Both are in the default (D948, D949), the router's −40% aim recorded as missed.

## 1. Pre-registration (commit 8525b9b5, before any paid run)

The router is promoted only if all hold, else deleted with its code and tests:

1. **Offline** (M2 v2's held-out families, as synth-test route logs): at least 98% of needed items keep their source
   among those the router reads, with at least 50% fewer live reads.
2. **End to end at $0** (`days-calls.ts --seeds 41-64 --days 28 --night-h 20 --suite train,longtail --arrive-days
   0-10 --noise-sources 995 --noise-vocab 1000 --notify-share 0.05`, the shipped weeks cards) against main:
   request-time connector calls a request at most −40%, hidden facts handed not worse than −1% relative,
   rare-connector facts handed not fewer.
3. **A Pi pair against main**: hidden facts' template-clustered lower bound above −2 points (cap $8 Anthropic).
4. **Speed and size**: at most 1 ms a request in TypeScript at 1,000 sources; shared model at most 4 MB.

The parent agreed (2026-11-11) to request-time calls as the bar, with steady state (request-time plus background
listings) reported beside it, since background listings are 59% of a request's calls at 1,000 sources and a router
of request-time reads cannot move them.

## 2. Data

- **M2 v2 worlds** (`eden-synth`, D880–D884): 2,128 / 274 / 293 worlds (train / val / test), split by family
  cluster, about 9.4 sources a world, the fact's source rare in about 30% of tasks. `m8-export.ts` turns them into
  the router's features with Eden's own tokenizer (terms hashed with FNV-1a over the folded term), so the Python
  trainers never tokenize and the engine reads the same numbers by construction.
- **Route logs** (`days-calls.ts --route-log`, D941): M2's worlds planted into sim users (`synth-train@10`,
  `synth-val@10`, `synth-test@10`: 10 worlds a user, 10 days, 12–16 requests a day, 1:1:3 hidden, control and
  neutral, arrivals 0–6 days before their request with no notice, 995 noise connectors with words of their own, 5%
  notifying). Each request's first routed lookup logs the engine's own inputs per source (every source with evidence,
  the planted source, and 40 others sampled with their weight), the request's hashed features, and each source's
  keys once a user. The router never sees the e2e suites (train1–6, longtail) in training.
- **Labels.** A hidden request needs its planted fact's source; control and neutral requests need nothing.

## 3. Rounds

### Round 1: ten architectures on M2 offline (`packages/sim/lab/m8/routers.py`, Haiku helper sessions)

Each request sees the user's sources plus 20 noise connectors and every item held before it except the needed fact
(its look-alike and neutrals are held, as in a deployment the fact is the new item). Test families, 17,243 requests:

| Candidate | Exploits | top1 | top3 | recall@5 | rare recall@5 | recall at the val-fit 98% threshold | reads there |
| --- | --- | --- | --- | --- | --- | --- | --- |
| c7: learned combiner (local evidence, type prior, names, history) | everything Eden measures | .64 | .88 | .95 | .94 | .964 | 5.3 |
| c5: local BM25 evidence (the request's best held matches per source) | the user's own items | .48 | .81 | .90 | .85 | .966 | 8.9 |
| c3: source as document, no identity (description + held terms) | unseen connectors | .36 | .74 | .91 | .85 | .972 | 6.9 |
| c3 binary codes (sign at inference) | 1-bit kernel | .35 | .74 | .91 | .85 | .972 | 7.0 |
| c9: item-level learned matching, log-sum-exp per source | which items point to the needed one | .34 | .70 | .89 | .84 | .971 | 6.9 |
| c2: hashed bag × learned source-type vectors | request phrasing | .26 | .57 | .80 | .62 | .976 | 8.6 |
| c1: naive Bayes over source type | topical words | .29 | .60 | .81 | .58 | .976 | 10.1 |
| c10 / c10d: wide conjunctions (term × type and description) | words to source kind | .29 | .59 | .81 | .62 | .977 | 9.6 |
| c6: names alone | who said it where | .36 | .60 | .65 | .47 | .967 | 26.3 |
| c4: per-user source language model | per-source vocabulary | .34 | .54 | .56 | .25 | .970 | 27.6 |
| c7 strict (the look-alike unseen too) | | .25 | .57 | .80 | .74 | .972 | 7.8 |

Reading: request words alone predict the source weakly (top3 near .6); what wins is the user's own evidence
(where the request's nearest held items live) weighed with a request × source prior and the user's history. A per-
source language model and names alone are poor. The strict row shows how much rides on the related items being
held: in a deployment a quiet fact usually lands beside its thread, which the routing reads.

### The engine router (C7 with Eden's own inputs)

Built from round 1: the conjunction table (c10's idea, keys from the source's kind and description, so a connector no
training saw is scored by its description) and the engine's per-source evidence into a small network (§0). Trained
on route logs (`train_router.py`: the table on M2's exported worlds with the noise connectors' keys as negatives,
then the network listwise over [nothing, sources] with sampled sources weighted; temperature and floor fit on
synth-val for 98% hidden recall).

### Round 2: variants (Haiku helper sessions; synth-val, 98% recall, share of live-readable sources cut)

| Variant | Cut |
| --- | --- |
| 16 hidden units, all 11 inputs | 47.0% |
| without size, change rate and hours since poll (surface cues, the parent's M3 note) | **48.6%** |
| without those and `whole` | 47.9% |
| 32 hidden units, 8 epochs | 45.8% |
| 8 hidden units | 46.3% |
| table fine-tuned on the route logs | 44.7% |
| no table at all | 46.4% |
| 2^20-bucket table | 43.8% |

The network saturates near 47–49%; the surface-cue inputs add nothing and are dropped (the shipped weights have zero
first-layer rows for them). The table adds about a point.

## 4. Measurements

### 4.1 The frozen model (commit c2923a86; `packages/engine/assets/router.bin`, 266,698 bytes)

Sixteen hidden units over the engine's inputs with the three surface cues dropped (size, change rate, hours since
poll: zero first-layer rows), the place of the source's best local match added (`top`), and a "nothing needed" head
over nine request-level inputs (`routerSummary`). The conjunction table: 2^18 int8 weights (256 KB) trained on M2's
exported worlds (123,540 requests, every style and language) with the 995 noise connectors' keys as negatives. The
network: 150 synth-train users (route logs `v3`), 4 epochs. The floor (0.00227) is the lower of the two 98%-recall
floors fitted on synth-val (40 users, 1,112 hidden) and on sim train1–4 users (18 users; the parent's note after M6:
validation must include sim families). The same training ran on Modal (`m8_router.py`, run `m8-final-a`, an earlier
summary head): val cut 51.4%, test recall 97.1%.

### 4.2 Offline, held-out families

| Set | Hidden requests | Needed source kept | Rare kept | Live-readable sources cut |
| --- | --- | --- | --- | --- |
| synth-test (80 users, M2's test families) | 2,226 | 96.8% | 93.5% | 53.9% |
| synth-test at the floor that keeps 98% there (read off, not chosen) | 2,226 | 98.0% | 95.5% | 45.0% |
| sim train1–4 (18 users, never trained on; floor-fitting set) | 821 | 98.5% | (none rare) | 62.1% |
| sim held-out families, fresh seeds 65–88 (from the e2e run's route log) | 1,128 | 93.7% | 85.7% | 59.1% |

The pre-registered offline clause (98% kept with at least 50% fewer reads) is missed on both held-out sets. "Kept"
counts a source; on the same fresh-seed requests the router handed more facts than main (§4.3), because most of
the skipped sources' facts were already held. The parent amended clause 1 accordingly (D947): facts handed decide,
the source proxy is a diagnostic.

### 4.3 End to end at $0 (`days-calls.ts`, 24 users × 28 days, 995 noise connectors, 5% notifying)

| Run | Arm | Request-time calls a request | Steady (request + background) | Hidden handed | Rare-connector facts | Decoys |
| --- | --- | --- | --- | --- | --- | --- |
| Pre-registered: seeds 41–64, train + longtail, shipped weeks cards | main | 5.327 | 13.35 | 509/1,129 | 39/105 | 465 |
| | router (frozen) | **3.676 (−31.0%)** | 11.58 (−13.3%) | 511 | 39 | 457 |
| Fresh seeds 65–88, held-out families (train5, train6, train5r, train6r, longtail), no cards | main | 4.534 | 12.35 | 422/1,130 | 53/175 | 342 |
| | router | 3.298 (−27.3%) | 11.07 | 429 | 53 | 346 |
| | router + dormant sweep | 2.349 (−48.2%) | 3.60 (−70.8%) | 432 | 52 | 337 |
| Fresh seeds 89–112, held-out families, no cards (dormancy's powered re-test, D949) | main | 4.939 | 12.88 | 442/1,104 | 59/184 | 333 |
| | router | 3.639 (−26.3%) | 11.50 | 445 | 63 | 335 |
| | router + dormant sweep | 2.193 (−55.6%) | 3.46 (−73.1%) | 453 | 62 | 340 |

Two runs of main on the same seeds were identical (`days-calls` at time scale 0 is deterministic). The pre-freeze
model (§3, e1 with the rare-word rule) read −43.2% on the pre-registered seeds; it was picked after seeing them, so it
does not count. The frozen model's calls rise as a user's sources get used (2.1 a request in the first week, 4.2 in
the fourth; main 2.9 → 5.8): items reaching the agent mark their sources used, which the network reads.

**The −40% aim was missed (−31.0%).** Every harm guard passed: hidden facts, rare-connector facts and decoys. The
parent decided (D947) that D112's standard, better or neutral at no extra paid cost, governs promotion, with the Pi
pair's clauses deciding.

### 4.4 Pi pair (`packages/sim/lab/m8/run.sh`, preset `bench-router`; Haiku 5.5 in every role, Anthropic direct)

PI_TABLE

### 4.5 Speed and size

- **Scoring** (`bench/router.bench.ts`, 1,000 sources, 2,000 requests, the frozen weights): 0.223 ms p50, 0.339 p90,
  0.81 p99 (the request's features, one conjunction score per distinct source key set, the network over every source).
- **In the engine** (the lab hook's own timing, `days-calls` seeds 41–44, 1,785 lookups at 1,000 sources, one
  process): 0.81 ms p50, 1.05 p90, 2.42 p99, every input read included (the per-user maps of 1,000 sources).
- **Shared model**: 266,698 bytes, read once a process. **Per user**: nothing new for the router (it reads
  `SourceYield` and the sync's state); the dormant sweep adds one number a (user, source), `routedAt` (8 bytes, about
  8 KB a user at 1,000 sources) **[EST: a JS number in an existing object]**.
- Parity: the engine's functions with the shipped asset against Python on 64 held-out requests: 64 of 64 agree
  (probabilities to 1e-6, every gate decision; `m8-parity.test.ts`).

## 5. Decision

- **D948: the router joins the default (part `router`)**, PI_DECISION
- **D949: the dormant sweep joins the default (part `dormant`)** on its powered re-test (pre-registered in acacab82):
  steady calls 11.50 → 3.46 a request against the router alone (−69.9%, bar −40%), hidden 453 against main's 442
  (bar −1%), rare-connector facts 62 against main's 59 (bar: main − 2% of 184 planted, 55.3), decoys 340 against 333.
  Its first test (seeds 65–88, rule d3951a6c) failed by one rare fact (52 against 53) and stands as read; the parent
  ordered the powered re-test with a pre-stated noise allowance (main's rare rate differed by 2.0 points between the
  seed halves, 27/92 against 26/83).
- **Deletion lag does not grow.** A synced item is held at most `syncTtlMs` (7 days) after its source last listed
  it, so a dormant source's copy lapses at day 7 (tested); between day 7 and 28 the source is read live only when the
  router finds it likely, and a copy D356 has not vouched for is re-read before it is delivered (tested). A source
  whose integrator forwards change notices is polled at its notice, dormant or not (tested).

## 6. Findings beside the router

### Rare-connector facts are lost after fetching, not before (D946)

Main's configuration, `days-calls.ts --pool-diag` with a flag for whether the planted item was held after its
request, seeds 41–48, 28 days, train + longtail, arrivals 0–10 days, 995 noise connectors. Of 31 hidden requests
whose fact sat in a rare connector:

| Stage | Requests |
| --- | --- |
| handed to the agent | 10 |
| never held by the request (no poll, sweep or search brought it in) | 3 |
| held, but not in the push's pool (retrieval and ranking) | 11 |
| in the pool, not handed (6 ranked in the first five, 1 below) | 7 |

28 of 31 were in the cache when asked. A router can only lose facts at the "never held" stage, so it cannot raise
rare facts much; the fix belongs to the pool's ranking (the wall H1 and M9 hit), a track of its own.
