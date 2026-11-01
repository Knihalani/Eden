# Ask answers that read the conversation (track askctx)

Decision: D83 (`askContext`, with `askContextWeight` and `askContextItems`), proposed, off by default. Development used
the development suites `dev6a`, `dev6b` and the old in-sample suites (`hidden`, `heldout`, `heldout2`–`heldout4`) only.
Held-out 5–11 were not run or read. No OpenRouter call was made; cards are replayed from
`packages/sim/lab/cards/cards-v2.jsonl`. Dev results and in-sample results are reported apart.

## The question

In the held-out-10 live run (Pi harness, ALL3) a planted item that reached the agent only in an `ask_context` answer was
raised 0.887 of the time, and in 59 of 192 tasks Eden held the item (synced) but never surfaced it. An agent's question
is often narrower than the user's request, or worded otherwise ("Globex discount approval?" for "Approve the 15%
discount Globex asked for on the renewal."), and `ask` ranked for the question alone. Two hypotheses:

1. an ask that also ranks for the session's latest user request (its names and days) cites the item the request needs
   when the agent asks narrowly, at no source call, no model call and at most +5% answer bytes;
2. when the proactive gate delivers nothing, one item with a structural verdict (a conflict hit, graph hit or violated
   card) is worth sending.

## Instrumentation (lab only)

- `packages/sim/src/narrow.ts`: a deterministic question narrower, `"<main name> <object> <action noun>?"` (the
  request's first capitalised phrase past openers, weekdays and months; the first plain word after the verb's article;
  the leading verb as a noun from a short list of English nominalisations, else the verb). Days, amounts and the rest of
  the request are dropped. Examples: "Hoppers table reservation?", "Tyrell Bio payment?", "time off?". **A simulation
  assumption**: no suite carries an agent's own questions, and held-out 10's recorded questions were not read (blind).
  Its word lists are generic English, written without reading planted items.
- `hidden-funnel.ts --ask-question narrow|request` (default `request`, unchanged behaviour): the ask's question is the
  narrowed request or the request. Each task now records `askMs` (the ask's wall time), `packetBytes` and `packets`;
  `--ask-diag` lines carry the `question`.

All runs: ALL3 (D80), seeds 41–44, real sync, cards replayed, `--ask`:

```bash
bun packages/sim/src/lab/hidden-funnel.ts --suite dev6a,dev6b,hidden,heldout,heldout2,heldout3,heldout4 --no-record \
  --config "$CFG" --cards packages/sim/lab/cards/cards-v2.jsonl --ask --ask-question narrow --json out.json
```

"Either" is delivered in a packet or cited by the ask. The precision proxies are control (decoy) delivered and control
ask-cited. Bytes per packet is over delivered packets; bytes per ask is the answer's size. Times are `--serial` wall
times per task on this machine (the engine's own CPU; the in-process connectors answer at once).

## Hypothesis 1: `askContext`

With the flag, `observe` keeps the cue of the session's latest user request (`Session.request`, the same object the
lookup used, so its frame, graph walk and verdicts are already computed). `ask` then:

- builds its own order as before (verdict hits, grounded, the rest above `candidateScore`);
- if the question is not the request (some request content word the question lacks) and is about it (shares a content
  word with it, or finds nothing of its own), ranks the request's cue over what is cached (no source call): its graph
  finds (reused), card finds, `rank`, its verdict hits on its best 16 plus graph and card finds (`contextHit`: the
  `cardViolated`, `graphHit` and `conflictHit` tests of `factsOf`, cheapest first) and its grounded items;
- fuses the two by weighted reciprocal rank (k = 2), a verdict hit of either first, the question's order breaking ties,
  and keeps at most `askContextItems` items.

An ask made with the request's own words is answered exactly as without the flag (the request-mode rows below are
identical). Verdicts are memoised per cue and item object while the flag is on (a pure function of both), which is what
keeps the ask's added time near a millisecond: without the memo and the lean hit test the fusion cost about 5 ms.

### Choosing the weight and the item cap (LOSO)

A 4 × 4 grid, `askContextWeight` ∈ {0.3, 0.5, 0.7, 1.0} × `askContextItems` ∈ {2, 3, 4, 5}, narrowed questions. For each
of the seven suites held out in turn, the setting is chosen on the other six: the most hidden ask-cites with ask bytes
at most 1.05 × the flag-off narrow baseline on those six. Every fold chose weight 1.0, four items; the held-out-suite
results pooled are the honest estimate:

| narrowed question                 | dev hidden ask-cited | dev hidden either | dev control ask-cited | dev bytes/ask | in-sample hidden ask-cited | in-sample hidden either | in-sample control ask-cited | in-sample bytes/ask |
| --------------------------------- | -------------------: | ----------------: | --------------------: | ------------: | -------------------------: | ----------------------: | --------------------------: | ------------------: |
| ALL3 (flag off)                   |                0.283 |             0.475 |                 0.142 |           741 |                      0.373 |                   0.840 |                       0.369 |                 787 |
| + `askContext`, LOSO (w 1.0, k 4) |                0.475 |             0.504 |                 0.329 |           736 |                      0.828 |                   0.896 |                       0.504 |                 684 |

A precision-first criterion (most hidden minus control ask-cites, same byte cap) chooses weight 0.3, two items in six
folds and 0.5, two items in one; LOSO: dev hidden ask-cited 0.429, control 0.133, 420 bytes; in-sample 0.739, control
0.276, 371 bytes. It is better than flag-off on every axis (more hidden cites, fewer decoy cites, 43–53% fewer bytes),
at a cost of 0.046 (dev) and 0.089 (in-sample) hidden ask-cites against the recall pick. The defaults are the recall
pick; the precision-first setting is `{"askContextWeight": 0.3, "askContextItems": 2}`.

Grid (all seven suites, so in-sample for the choice):

| w, k   | dev hidden ask | dev control ask | dev bytes | in hidden ask | in control ask | in bytes |
| ------ | -------------: | --------------: | --------: | ------------: | -------------: | -------: |
| 0.3, 2 |          0.429 |           0.133 |       420 |         0.743 |          0.250 |      373 |
| 0.3, 3 |          0.446 |           0.154 |       578 |         0.784 |          0.347 |      531 |
| 0.5, 3 |          0.446 |           0.146 |       578 |         0.784 |          0.377 |      532 |
| 0.7, 4 |          0.463 |           0.321 |       731 |         0.813 |          0.493 |      680 |
| 1.0, 4 |          0.475 |           0.329 |       736 |         0.828 |          0.504 |      684 |
| 1.0, 5 |          0.475 |           0.362 |       877 |         0.843 |          0.537 |      813 |

(The other ten cells are in the run outputs; the weight moves results by at most 0.03 at a fixed cap, the cap moves them
most.)

### The committed defaults, both question modes

`--serial`, ALL3 vs ALL3 + `askContext` (weight 1, four items):

| run                   | group | hidden either | hidden delivered | hidden ask-cited | control delivered | control ask-cited | bytes/packet | bytes/ask | observe ms | ask ms |
| --------------------- | ----- | ------------: | ---------------: | ---------------: | ----------------: | ----------------: | -----------: | --------: | ---------: | -----: |
| request, ALL3         | dev   |         0.508 |            0.404 |            0.508 |             0.042 |             0.379 |          353 |       661 |        9.3 |    6.4 |
| request, + askContext | dev   |         0.508 |            0.404 |            0.508 |             0.042 |             0.379 |          353 |       661 |        8.7 |    5.8 |
| narrow, ALL3          | dev   |         0.475 |            0.404 |            0.283 |             0.042 |             0.142 |          355 |       741 |        9.2 |    4.0 |
| narrow, + askContext  | dev   |         0.504 |            0.404 |            0.475 |             0.042 |             0.329 |          355 |       736 |        8.7 |    4.9 |
| request, ALL3         | in    |         0.910 |            0.806 |            0.910 |             0.063 |             0.552 |          341 |       638 |        8.4 |    8.3 |
| request, + askContext | in    |         0.910 |            0.806 |            0.910 |             0.063 |             0.552 |          341 |       638 |        8.5 |    7.8 |
| narrow, ALL3          | in    |         0.840 |            0.806 |            0.373 |             0.063 |             0.369 |          341 |       787 |        8.9 |    4.2 |
| narrow, + askContext  | in    |         0.896 |            0.806 |            0.828 |             0.063 |             0.504 |          341 |       684 |        8.8 |    6.1 |

- With the request's own text the flag changes nothing (identical answers); with a narrowed question it recovers most of
  what the request-text ask cites (dev 0.475 of 0.508; in-sample 0.828 of 0.910) at fewer bytes than the narrow ask.
- Where the planted item lands in the answer matters for uptake: a verdict hit of either list first puts it first in
  251 of 508 hidden asks (request-text ask: 290; narrow ask: 106; an earlier build without verdict-first, weight 0.7,
  five items, no relatedness gate: 133).
- Cost: no source call, no model call, packets unchanged, ask bytes −1% (dev) and −13% (in-sample) against the narrow
  ask. Ask time +0.9 ms (dev) and +1.9 ms (in-sample) per ask with a narrowed question; nothing added to `observe`.
- Precision: control ask-cites rise with recall (dev 0.142 → 0.329, in-sample 0.369 → 0.504) to just under what ALL3's
  request-text ask already cites (0.379, 0.552). The decoys are resolved, expired, or about another entity or date; how
  often an agent turns a cited decoy into a false concern was not measured here (held-out 10's live false-concern rate
  for ALL3, 0.052, is as given for this track, not re-run). Unmeasured live for narrowed questions.

`bun run eval` with every flag off equals main's except the two latency lines (`latencyP50Ms`, `latencyP95Ms`).

## Hypothesis 2: one structural-verdict item when the gate is silent

Measured from `--candidates` dumps (request mode, ALL3) before building anything:

- Silent tasks (the gate delivered nothing): dev 90 hidden, 158 control; in-sample 26 hidden, 135 control. Among every
  candidate the fast path, anticipation and the lookup read for them, one with a structural verdict (`conflictHit`,
  `graphHit`, `cardViolated`, `bridged`) exists in 3 + 4 hidden and 7 + 7 control tasks, and is the planted item in
  **none**. With the looser plain `conflict` verdict, once in 116 silent hidden tasks.
- Where the gate does deliver, a planted structural hit left out of the packet: dev 3 hidden, 0 control; in-sample 12
  hidden, 5 control. Sending the best undelivered hit in every delivering lookup would add 134 items over 1,016 tasks
  (11 planted, 5 decoys, 118 other), about +14% packet bytes per task against the +5% budget.

Rejected: the gate already sends every structural verdict it can see; a silent task's planted item is not a candidate
at all (dev: 89 of 118 missed hidden items are never among any lookup's candidates, all of them cached), which is a
retrieval problem (the lexical "none" band), not a slot problem.

## Verdict

Adopt `askContext` (weight 1, four items) into the next recommended configuration, pending a live Pi run on a fresh
blind suite in which agents ask in their own words. The lab gain depends on how often real agents ask narrowly; it is
zero when they ask with the request's text and never negative there.

## Risks

- The narrower is a simulation assumption; real questions may be broader, multi-part, or about other things. The
  relatedness gate (a shared content word, or no answer of its own) is untested on real off-topic asks.
- Decoy citations in answers rise to the request-text ask's level; a live false-concern measure on narrowed asks is
  missing.
- `Session.request` is the latest user message that triggered a lookup; in a long session an ask about an earlier
  request is fused with the latest one (the gate drops it when no word is shared).
- The verdict memo is keyed by cue and item object; correct because items are replaced, never mutated, in the cache.
  It is on only with the flag.
