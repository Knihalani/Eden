# The smarter tracks combined: ALL4 (track combined)

Decision: D84, proposed until the live measure. ALL4 = ALL3 (D80) + `supersede` (D81) + `askRank` (D82) + `askContext`
(D83). Every flag stays off by default. Chosen on the development suites `dev6a`, `dev6b` and the old in-sample suites
(`hidden`, `heldout`, `heldout2`–`heldout4`) only; held-out 5–11 were not run or read. No model call and no OpenRouter
spend: cards are replayed from `packages/sim/lab/cards/cards-v2.jsonl`. Every number below comes from
`hidden-funnel.ts` runs in this session (seeds 41–44, `--ask`).

## What was combined

Three branches were merged onto `origin/main` (`1418bfa4e`): `smart/supersede` (`ba16820a8`), `smart/rank`
(`1aab11cc7`) and `smart/askctx` (`432d64a2f`). Each claimed D81; they are renumbered D81 (`supersede`), D82
(`askRank`, `rankTies`) and D83 (`askContext`). `rankTies` and `supersedeThreads` stay rejected and are not in ALL4.

All three act on the same few lines of `ask`. Their order in the merged code:

1. The pool is built as before (verdict hits, grounded items, lexically likely).
2. `supersede` filters the pool: an item a newer decisive item about the same matter replaced is dropped, and so is a
   settled item when the ask is an action.
3. `askRank` orders the filtered pool by the learned ranker and may give the weakest seat to its best candidate from
   outside the pool, by the margin. With `supersede`, that outsider is checked against the pool it joins and loses the
   seat if `supersede` would drop it.
4. `askContext` fuses the result with the session request's own order (reciprocal-rank fusion, verdict hits first).
5. With `supersede`, the fused answer is filtered again. An item only the request found is judged as the request
   would judge it, so a settled twin pulled in by the request's words is dropped even when the agent's question is a
   question. This step is new in the merge. Without it, ALL4 with narrow questions cited the decoy in 77 dev and 124
   in-sample control tasks; with it, 52 and 101 (hidden either unchanged at 121 and 240; in-sample hidden ask-cited
   224 → 220).

Verdicts are memoised per cue when `supersede` or `askContext` is on (the two tracks had separate memo maps; they now
share one). With every flag off, `bun run eval` matches `origin/main` except the two latency lines.

## Two ask modes

- **request**: the funnel asks with the request's own text (the earlier tracks' default). `askContext` is a no-op
  here by construction.
- **narrow**: the question is the request narrowed as an agent might word it (`narrow.ts`, the askctx track's
  simulation). This is closer to a live agent but is a simulation assumption.

## ALL3 vs ALL4 (askRank's weights leave-one-suite-out)

Each suite runs with `askRank` weights fitted without it (the rank track's folds), so the `askRank` part of every
number is the LOSO estimate. Nothing else is learned. The ask settings of `askContext` (weight 1, 4 items) were picked
by the askctx track's LOSO; they were not re-tuned here.

| ask | group | config | hidden either | hidden delivered | hidden ask-cited | control delivered | control ask-cited | bytes/ask | bytes/packet |
|---|---|---|---|---|---|---|---|---|---|
| request | dev | ALL3 | 122/240 | 97 | 122 | 10 | 91 | 661 | 353 |
| request | dev | **ALL4** | **127/240** | 97 | 127 | 10 | **53** | 655 | 353 |
| request | in-sample | ALL3 | 244/268 | 216 | 244 | 17 | 148 | 638 | 341 |
| request | in-sample | **ALL4** | **245/268** | 216 | 239 | 17 | **50** | 625 | 336 |
| narrow | dev | ALL3 | 114/240 | 97 | 68 | 10 | 34 | 741 | 355 |
| narrow | dev | **ALL4** | **121/240** | 97 | 114 | 10 | 52 | 733 | 355 |
| narrow | in-sample | ALL3 | 225/268 | 216 | 100 | 17 | 99 | 787 | 341 |
| narrow | in-sample | **ALL4** | **240/268** | 216 | 220 | 17 | 101 | 676 | 336 |

Task by task (ALL3 → ALL4):

- request, dev: hidden either +5 / −0; the ask stopped citing the decoy in 41 control tasks and newly cited it in 3.
- request, in-sample: hidden +5 / −4 (the losses: two heldout3 templates, see risks); decoy cites gone 101, new 3.
- narrow, dev: hidden +8 / −1; decoy cites new 25, gone 7.
- narrow, in-sample: hidden +15 / −0; decoy cites new 19, gone 17.

Gains are lumpy: in dev both modes' gains come from two templates each (request: `december-capacity` 4,
`reload-done` 1; narrow: `class-photo` 4, `offsite-headcount` 4).

## Leave one flag out of ALL4

| ask | config | dev either | dev control ask-cited | in-sample either | in-sample control ask-cited | bytes/ask dev / in |
|---|---|---|---|---|---|---|
| request | ALL4 | 127 | 53 | 245 | 50 | 655 / 625 |
| request | − `supersede` | 127 | 73 | 245 | 82 | 671 / 657 |
| request | − `askRank` | 122 | 52 | 245 | 62 | 643 / 599 |
| request | − `askContext` | 127 | 53 | 245 | 50 | 655 / 625 |
| narrow | ALL4 | 121 | 52 | 240 | 101 | 733 / 676 |
| narrow | − `supersede` | 121 | 77 | 239 | 124 | 732 / 679 |
| narrow | − `askRank` | 121 | 54 | 241 | 114 | 735 / 680 |
| narrow | − `askContext` | 109 | 20 | 222 | 71 | 752 / 782 |

(The "− `askRank`" narrow row and both ALL4 rows include step 5; the "− `supersede`" rows have no step 5 by
definition. The − `askContext` rows are unaffected by step 5.)

Each flag earns its place in at least one mode:

- `supersede` is the precision flag: removing it adds 20–32 decoy cites in every group, with no surfacing change.
- `askRank` adds +5 dev surfacing (request) and cuts in-sample decoy cites (62 → 50 request, 114 → 101 narrow).
  Narrow in-sample it costs one hidden task (241 → 240).
- `askContext` is the surfacing flag when the agent words its own question: +12 dev and +18 in-sample either, at
  +32 dev and +30 in-sample decoy cites. It does nothing when the agent asks with the request's text.

A precision-first `askContext` (weight 0.3, 2 items, the askctx track's alternative) under ALL4, narrow: dev either
111, decoy cites 23, 417 B per ask; in-sample 232, 45, 379 B. It surfaces less than ALL3 on dev (114), so the default
(1, 4) is kept for ALL4.

## Budget

- **Model and source calls:** none added. No per-event work added on the observe path except keeping the request's cue.
- **Bytes:** ask answers are smaller in all four groups (−1% to −14%); packets are the same or smaller (353 → 353,
  341 → 336). Within the +5% budget.
- **Eden CPU:** serial, interleaved runs, one at a time on a 4-core machine shared with other jobs (read the direction):

| ask | group | ms per lookup (observe), ALL3 → ALL4 | ms per ask, ALL3 → ALL4 |
|---|---|---|---|
| request | dev | 16.70 → 15.40 | 9.55 → 8.82 |
| request | in-sample | 13.36 → 13.10 | 10.22 → 9.63 |
| narrow | dev | 14.79 → 16.54 | 5.37 → 8.04 |
| narrow | in-sample | 14.10 → 12.92 | 5.15 → 7.44 |

The lookup is not slower (the dev narrow rise is noise: `askContext` does nothing on observe beyond keeping the cue,
and the other three groups fell). A narrowed ask costs about 2.3–2.7 ms more: `askContext` ranks the request again over
the cache. That is within "a few ms" per lookup, but it is +45–50% of the ask's own CPU; the agent's model call it
precedes takes seconds.

## Review fixes

A review of the merged branch (REQUEST_CHANGES) found that `supersede` could hide a block that still stands, and four
smaller issues. Fixed, each with a test that failed first:

1. **A newer item about another point no longer supersedes** (`supersede.ts`, `conflict.ts` `matterWords`). Before,
   any newer decisive item in a matter's group won: "Re: Globex account: billing address change done, all resolved"
   (read as `clear`) or "invoice INV-12 paid in full" (read as `conflict`) hid "Globex is on credit hold until 30 Nov,
   no new orders", and an ask about a Globex order cited nothing (or only the address reply). Now a newer item
   supersedes only when its deciding statement shares a word with what the older one says, the request's names left
   out and a constraint's irregular forms folded ("frozen"/"freeze"). `assess` reports the words of the statements
   behind its verdict (`said`), memoised with the verdict per cue.
2. **A packet left with only the clearance is not sent** (`deliver`). A proactive packet drops a clearance that
   replaced one of its items (the agent never saw the block it lifts), and a packet left empty is silence. Before,
   "Ship the Kestrel release on Tuesday 3 November" with `groundConflict` + `supersede` delivered only "Kestrel release
   freeze lifted". `deliver` returns null for such a proactive packet; its two callers that pushed or handed out the
   result skip it (the action check proceeds, reason `superseded`).
3. **The request's order is ranked once per request, not once per ask** (`requestOrder`). The session keeps the
   request's `askOrder` keyed to the request's cue, the user's cache revision (`ItemCache.revision`, which changes when
   an item is added, changed or dropped, not when a lookup only refreshes it) and a minute. Later asks about the same
   request reuse it. The first narrowed ask after a request still pays for it: the funnel asks once per task, so its
   ask times do not move (below).
4. **An item the ranker seats drops what it supersedes.** After `askRank` seats an outsider, the order is read by
   `supersede` again, so the outsider and the older item it replaces are never both cited.
5. **The ranker's weights carry a fingerprint of the facts' definition** (`facts-fingerprint.ts`, `rank-weights.json`
   `facts`), checked by `rank.test.ts`; `rank-fit.ts` writes it. smart-rank.md now says that the shipped weights are
   in-sample on every suite here, and that ask dumps from main and from this branch are not comparable (`bridged`).

Re-run of ALL4 on the same suites, seeds, cards and fold weights (`askRank` LOSO), three runs at a time:

| ask | group | hidden either | hidden delivered | hidden ask-cited | control delivered | control ask-cited | bytes/ask |
|---|---|---|---|---|---|---|---|
| request | dev | 127 → 127 | 97 → 97 | 127 → 127 | 10 → 10 | 53 → 53 | 655 → 656 |
| request | in-sample | 245 → 245 | 216 → 216 | 239 → 239 | 17 → 17 | 50 → 49 | 625 → 628 |
| narrow | dev | 121 → 121 | 97 → 97 | 114 → 114 | 10 → 10 | 52 → 52 | 733 → 733 |
| narrow | in-sample | 240 → 240 | 216 → 216 | 220 → 219 | 17 → 17 | 101 → 101 | 676 → 676 |

Task by task: one control task stopped citing its decoy (heldout3 `drinks-surprise-party`, request), one hidden ask
lost its planted item (hidden `calendar-clash` seed 42, narrow; still delivered proactively, so "either" holds), and
19 request-mode answers keep one more item (inferred, not traced: an item the old grouping rule dropped). No packet changed:
the funnel's suites hold no packet of a lifted block alone. The fixes cost the funnel nothing measurable and close the
missed-warning cases above, which the suites do not contain.

**Ask latency.** End to end as the funnel times an ask (its sources are in-process, so this is nearly all Eden CPU),
from the serial ALL3 and ALL4 timing runs of the merge: narrowed asks p50 3.72 → 5.64 ms dev and 4.04 → 6.46 ms
in-sample, p95 15.77 → 22.01 and 12.20 → 15.59; request-text asks are not slower (p50 7.20 → 6.19, 8.77 → 8.49). That
is far over +5% of Eden's own ask time. The fix above removes it for every ask after the first about one request; it
does not for the first. Against a real source round trip it is under 5% only if that round trip is at least about
50 ms (2.5 ms / 0.05; derived, not measured here). The live Pi measure must report the ask's end-to-end p50/p95 with
real sources before `askContext` is adopted.

## Risks

- **Narrow is a simulation.** The question narrower is the askctx track's assumption; how live agents word
  `ask_context` decides `askContext`'s gain. The next live run should record the Pi harness's real asks.
- **Precision proxy rises with narrow asks on dev** (34 → 52 decoy cites) while surfacing rises (68 → 114 hidden
  ask-cited). Whether a cited decoy becomes a false concern was not measured live (ALL3's live rate was 0.052).
- **Lost hidden tasks.** request, in-sample: four tasks in two heldout3 templates (`cat-feeding-friend-away`,
  `family-day-out-mobility`) are no longer surfaced. Hidden ask-cited there is 244 under ALL3, 243 without
  `supersede` and 241 without `askRank`, so both flags contribute to the loss (the rank track reported the same
  heldout3 losses for `askRank`, the supersede track one template for `supersede`).
- **Lumpy, one-author suites.** Gains concentrate in a few templates; dev6a/dev6b copy some held-out 5–9 templates.
- **Refits.** `askRank`'s weights must be refit when the facts' computation changes; the shipped weights are the full
  fit (in-sample for these suites), so only the fold runs above are honest for it.
- **Not done here:** the `reviewer` subagent (no agent tool in this session) and the live Pi measure.

## Reproduce

```bash
CFG=...   # ALL3 JSON (D80) plus {"supersede":true,"askRank":true,"askContext":true}
for s in dev6a dev6b hidden heldout heldout2 heldout3 heldout4; do
  bun packages/sim/src/lab/hidden-funnel.ts --suite $s --no-record --config "$CFG" \
    --cards packages/sim/lab/cards/cards-v2.jsonl --ask --ask-question narrow \
    --rank-model folds/$s.json --json all4.narrow.$s.json
done
```

`folds/` is `rank-fit.ts --folds` output (docs/research/smart-rank.md).
