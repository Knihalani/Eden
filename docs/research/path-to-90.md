# A path to 90% of facts found: diagnosis, hypotheses, first tests

Status: 2026-11-01. Research note, no engine change. Every number comes from a command run this session; estimates are
labelled as such.

## Where facts are lost

Facts found = P(the decisive item reaches the agent) × P(the agent uses it when it does).

On held-out 11 with ALL3 (D85; 382 hidden tasks, live, Pi harness):

| Route | Tasks | Raised |
|---|---|---|
| Planted item in a proactive packet | 102 | 0.88 |
| Only in an `ask_context` answer | 135 | 0.99 |
| Neither (never reached the agent) | 144 | 0 |

- Reach is 62%; use is 88–99%.
- 90% overall needs reach of about 93% with use held at about 97%. Reach is the gap.

On the development suites (dev6a and dev6b, 240 hidden tasks, no model, `--ask`, `--ask-diag`, `--candidates`):

| Outcome | Tasks |
|---|---|
| Surfaced (packet or ask answer) | 118 |
| In the ask pool, ranked out | 27 |
| A proactive candidate, gated | 2 |
| Never a candidate at all | 89 |

The 89 never-candidates miss on every seed, so the misses are systematic: the request and the decisive item share no
words ("approve the laptop order" against "spend over £5,000 needs a second signature").

## Tested this session

### Full card coverage

Cards were enriched for every dev item that passes the prefilter: 876 items, 88 calls, $0.0117, $0.0000134 per item.

| Card replay | Surfaced (hidden) | Decoys delivered | Decoys ask-cited | Never a candidate |
|---|---|---|---|---|
| Partial | 122 | 10 | 91 | 89 |
| Complete | 129 | 23 | 100 | 75 |

The cards themselves are mostly right: the second-signature card reads "limit, actions purchase/pay/sign, £5,000, until
13 Nov". The weak links are the request side (rule-based action classes) and the grounding rules, which turn card
matches into decoys as readily as into facts. More cards, on their own, are not the answer.

### Synthetic requests per item (doc2query)

At sync time a cheap model writes up to four requests each item would change, in a user's words. It never sees the
suites' requests.
- Coverage: 1,607 items, 1,102 with requests.
- Cost: $0.0147 for all items, glm-5.3-flash, cheapest endpoint.
- Scoring: BM25 over all ~1,500 items of the user's world (seed 41), offline.

Decisive item in the top 5, hidden variant (60 tasks):

| Method | Top 5 |
|---|---|
| Item text | 28 (47%) |
| Synthetic requests | 36 (60%) |
| Fused (reciprocal rank) | 32 (53%) |
| Either list | 41 (68%) |

The decoy in the top 5, control variant (60 tasks):

| Method | dev6a | dev6b |
|---|---|---|
| Item text | 14 | 12 |
| Synthetic requests | 15 | 9 |
| Either list | 18 | 14 |

- The model wrote no requests for many resolved decoys, which helps precision on dev6b.
- This is the strongest reach lever found: +13 to +21 points of top-5 recall.
- The literature agrees: docTTTTTquery raised BM25 recall@1000 on MS MARCO from 0.853 to 0.939, and MRR@10 from 0.184
  to 0.265 (Nogueira and Lin, 2019).

### Guided asking (tenant-side tool description)

Live, Pi harness, dev suites, seeds 41–42. The $0.08 per-process caps cut runs to 88–96 of 120. Paired on the tasks
present in both: 82 hidden and 77 control. Spend $0.27.

| | Standard description | Guided description | Paired difference |
|---|---|---|---|
| Hidden raised | 0.415 | 0.524 | +0.110 (+0.024..+0.195) |
| False concern | 0.039 | 0.117 | +0.078 (+0.013..+0.143) |
| Agent $/1k | 0.500 | 0.567 | +13% |
| Wall p50 | 7.2 s | 10.3 s | |
| Output tokens | 887 | 1,057 | |

The guided description is `ASK_DESCRIPTION_GUIDED`: "before you act, ask what could block, constrain or change the
action…". The agent's own model bridges the vocabulary gap when it is asked to, but it also becomes more cautious
overall. It is a real lever with a precision and latency cost, not a free win.

## Hypotheses, ranked by expected effect on reach

Expected gains are estimates unless marked measured.

1. **Synthetic-request index (doc2query) at sync time.**
   - Index each item's synthetic requests next to its text, and fuse the two in lookup, probes and ask.
   - Cost: one cheap call per new item in the background, about $0.0000134 per item (measured with cards' batch shape).
     At 50 new items a day that is about $0.02 per user-month.
   - No request-path cost.
   - Expected: reach up 10–20 points (offline top-5 recall measured +13 to +21).
   - Risk: decoys that also get requests. The model's own "would change nothing" judgement cuts some.
   - It can share the card call: one prompt returning the card and the requests.
2. **Guided asking with a precision guard.**
   - The tenant-side description (or Eden's MCP tool description) asks the agent to probe for blockers. Eden's answer
     then states plainly when nothing blocks ("no rule, hold or change found for X"), so a cautious agent has a reason
     to stop.
   - Measured +11 points of facts but +7.8 points of false concerns.
   - The guard to test: Eden says explicitly when its sources hold nothing relevant, and the description asks the
     agent to raise only what the partner's data shows.
3. **A request-time bridging query from a small model.**
   - On a request that acts, one very cheap call rewrites it into 2–3 constraint queries (rules, limits, holds,
     availability for the named things), off the fast path.
   - Cost estimate: about $0.00005 per action request, roughly +10–15% of the agent's cost per task.
   - Expected: much of what doc2query gains, from the other side. The two may stack.
4. **An active-constraints digest in a cached prompt prefix.**
   - Give the agent a compact list of the user's live constraints (cards of kind freeze, limit, absence, hold,
     deadline, active now), in a stable prefix that provider prompt caching prices low.
   - The agent's model then matches semantically.
   - Cost estimate: the dev worlds have on the order of 50 constraint cards per user, about 1,250 tokens. Cached, that
     is roughly +5–10% of input cost. It needs a relevance cut (the top 10–15 by the synthetic-request index) to stay
     small.
   - Expected: large, for constraint-type facts. Risk: over-caution, as with guided asking.
5. **Uptake of packets.** Packets are used 0.88 of the time, against 0.99 for ask answers. Make a packet look like an
   answer to the request (lead with the item's bearing on the request). Small but cheap: about +4 points of facts.
6. **Supersession and ranking (D81–D83).** Measured live (D85): they cut cost 7–8% and decoy citations, with no gain
   in facts. They stay available to pair with 1–4 for precision.

### What 90% would take, roughly

- Doc2query (1) and a bridging query (3) together could plausibly bring reach to 80–85%.
- Guided asking (2) with its guard, or the digest (4), the remainder.
- Uptake fixes (5) bring use to about 95%.

That is an estimate, not a measurement. Every piece needs the usual pre-registered blind test, and 90% on the
simulated suites is not 90% on real accounts. The closest public benchmarks (PARE, ASTRA-bench, π-Bench, 2026)
report frontier agents around 40% on proactive constraint-finding.

## Also found

- **Secret gate.** One simulated ask answer showed an AWS secret access key next to its redacted access key id
  (`[REDACTED] / ecmkge7Z…`). The gate caught the id, but the 40-character secret, with no
  `aws_secret_access_key` keyword beside it, passed.
- This is a real gap. Proposed fix: treat a 40-character base64 token within a few characters of a redacted AWS key
  id as a secret. Re-run the gate's benchmark per D24.

## Reproduce

Scripts: `diag90/d2q.py` and the dumps are in the session scratchpad, not the repo.
- Enrichment: `cards-enrich.ts --funnel dev6a,dev6b --cap 0.15 --sort price`.
- Diagnostics: `hidden-funnel.ts --suite dev6a,dev6b --ask --ask-diag … --candidates …`.
- Live: `pi-ab.ts --suite dev6a,dev6b --conditions eden~ALL3 --ask-description standard|guided`.
