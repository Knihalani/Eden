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
- **What it did.** See §5 (decision) and §4 (measurements).

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

(Filled from the final runs below.)

## 5. Decision

(Filled below.)

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
