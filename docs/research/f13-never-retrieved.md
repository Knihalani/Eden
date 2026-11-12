# F13: why hidden facts are never retrieved (train and dev20, shipped coverage, world clock)

Status: 2026-11-12, branch `claude/f13-retrieval` (from main 9f73a3da), session F13. $0, simulated worlds only. Every
number comes from the commands at the end.

## 1. The classification

`bun run funnel --suite train,dev20 --seeds 41,42,43,44 -- --neutral --corpus-dump` (the default, shipped coverage on
the world clock). A hidden task is **never retrieved** when its planted item is not in the push's pool, no ask cited
it and nothing delivered it: **train 70 of 768 (9%), dev20 255 of 640 (40%)**; 325 of 1,408 pooled (23%).

`packages/sim/lab/f13/missed.ts` classes each (content terms as the engine reads them, `contentTerms`, the request
with its glossary English, `glossOf`; the item's card and anticipated requests from the shipped replay):

| class | train | dev20 | pooled |
| --- | ---: | ---: | ---: |
| (a) not cached (sync or coverage) | 0 | 0 | 0 |
| (b) cached, no content term shared with the request; the card's requests share none either | 18 | 95 | 113 (35%) |
| (b) cached, no term shared; the item has no card at shipped coverage | 4 | 87 | 91 (28%) |
| (b/c) no term shared with the request, but the card's requests share one (intent index under its bar or past its cut) | 28 | 34 | 62 (19%) |
| (c) shares a term with the request, ranked out of the pool | 20 | 39 | 59 (18%) |
| (d) source not queried | 0 | 0 | 0 |

(d) is 0 because the funnel's worlds hold at most 13 sources, all synced whole: every lookup ranks the whole local
index. On dev20, 116 of the 255 also started no push (the request was not read as acting); the ask, which the funnel
always makes, missed them too, so the push's start is not what loses them.

The misses that share no term are world-knowledge bridges: "Email Skyline Broadband … leave when my contract ends"
against "Order confirmed: Fibrely Full Fibre 500"; "Transfer the £8,000 for the car to Riverside Motors" against
Jamie's "the Audi … don't send them anything yet"; "Pay my £1,284 self assessment balance to HMRC" against "Your
computation"; "Delete the old support-ticket exports" against a legal-hold notice.

## 2. The levers, against the integrator's bar

The bar (set by the integrator before any screen): hidden surfaced +5 points, decoys surfaced at most half the hidden
gain, CPU p99 at most +2 ms a request.

- **A dense second leg (an encoder's candidates unioned into the pool)** reaches class (b), but it has been built and
  rejected three times: D1142 (F2, `pushPoolQuota`), D1150 and D1151 (F1). It adds look-alikes at about 0.6 per fact
  in the pool (F2 offline, dev20 +47 / +28) and neutral packets above their bar after the check. It also fails the CPU
  bar by construction: `multilingual-e5-small` int8 takes 4–5 ms a request on one thread (F2, D1142).
- **Query-side expansion** (pseudo-relevance feedback, a distilled term table) is D189 and D1001: look-alikes as fast
  as facts. In these suites the look-alike is the fact's twin about another instance, so any bridge by meaning or by
  related words retrieves both; only the instance (day, reference, amount) parts them, and that is the check's job.
- **Widening the intent index's bar and cut** (no model, CPU-cheap) is the only lever left for (b/c). `--ask-diag`
  over the four seeds bounds it: hidden unranked 285 of 1,408, of them under the thresholds 24 and past the
  `intentHits` cut 44 (+68 at most, 4.8 points), against look-alikes 53 and 21 (+74). Even a widening that caught
  every one fails both the +5 and the half bar; the past-cut bucket alone (+44 / +21) keeps the half bar at 3.1
  points.
- **Carding the items the prefilter skips** (class (b) with no card): the ask's unranked planted items the prefilter
  rejected are 50 hidden against 114 look-alikes, and a card only helps when its requests share a term with the
  request (62 of the 325 above had one and still missed).

**Finding (D1302): no lever reachable with no model, or within +2 ms of CPU, clears the bar on these suites.** The
retrieval gap is a meaning gap between twins, and closing it needs a reader of the instance. The one design that
reached facts at an acceptable look-alike rate is D1150's (the encoder's picks read by the check: added fact named
42 of 42, look-alike 4 of 26), which failed on neutral packets after the check and costs a model in every process;
it is F1's to reopen.

## Reproduce

```bash
env -u OPENROUTER_API_KEY bun run funnel --suite train,dev20 --seeds 41,42,43,44 --json .local/f13/base.json \
  -- --neutral --corpus-dump .local/f13/corpus2.jsonl
env -u OPENROUTER_API_KEY bun packages/sim/lab/f13/missed.ts .local/f13/base.json .local/f13/corpus2.jsonl \
  --cards packages/sim/lab/distilled/cards-shipped.jsonl.gz [--sample 40]
env -u OPENROUTER_API_KEY bun run funnel --suite train,dev20 --seeds 41,42,43,44 -- --ask-diag .local/f13/askdiag.jsonl
```
