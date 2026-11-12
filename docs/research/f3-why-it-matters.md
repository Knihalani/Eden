# F3: saying why a handed item matters to this request

Status: 2026-11-12. Rejected twice on pre-registered rules, and deleted:
- `packetWhy`, the clash note (D1120 → D1121; then v2, D1122 → D1126);
- `packetChanges`, the "changed at its source: was X, now Y" line (D1123 → D1126).

The code is in dcf47d8d5 and bf3f577c1. The silent-edit lab harness stays (D1123, D1125): `HiddenTask.before`,
`silent.ts`, `--noise-edits`, `<train>+silent`, and dev20's `before`. **Finding (D1126):** on silent edits the loss is
freshness, not wording. A silently edited item in a source the request's lookup does not poll is handed over as its
pre-edit copy, and that copy is never raised.

## The problem

The H19 diagnosis ([h19-diagnosis.md](h19-diagnosis.md) §3) found 16 of 160 hidden facts on heldout19 that Eden's
packet carried and the agent did not raise:

- 13 of the 16 were calendar or drive items, and 11 of those were edited silently.
- The packet showed the item as it now reads ("workshop 14:00–17:30"), but nothing tied it to the request ("Book me
  the 16:40 train home on Thursday"). The agent did not work out the clash.

heldout19 was not used for anything here. Every choice below was made on train1–6 and train1r–6r at $0, and the one
paid run is on train.

## What Eden can know, without a model

**Versions.** Eden keeps one copy of each item. `ItemCache` replaces a changed copy when a sync stores it. The only
record of an earlier version is the session ledger's times for items already handed to that session (`revisionDiff`,
D342, which writes "no longer: 09:30" on an "updated:" packet).

An item edited before Eden first synced it has no earlier version anywhere. That covers every one-request task in the
lab: the world is backfilled once, then asked. So "changed on 23 Oct: was 11:00–15:00" cannot be said for the H19
case. It needs a store of earlier times per item, kept across sessions and persisted with the frozen user. Nothing in
the lab can measure that store today, since no suite edits an item between two syncs before the request. It is left
as a recommendation (below).

**Clashes.** The no-model grounding already reads the request's days (`timeWindow`, D44) and the time it asks to fill
(`requestedSpan`, D48). An item's own dates and times are in its `meta.start` and its text. Setting one against the
other is arithmetic, and it is what the agent skipped.

## The trial: `packetWhy` (`packages/engine/src/why.ts`)

With the switch on, each item a packet or an ask answer hands over gets Eden's note before its title, when its dates
meet a day the request names:

```
- [calendar] (Eden: dated Thu 5 Nov, a day the request names; its 08:40-08:55 overlaps the request's 08:30) Blood test — Parkside Surgery: When: …
- [calendar] (Eden: runs Fri 30 Oct to Fri 27 Nov, which takes in the request's Mon 2 Nov) Zoë Müller — parental leave: …
```

How the note is built:

- **The item's days.** An event's start day, and a range its text writes that holds that day ("26 Oct to 18 Jan").
  For an item with no start, the dates its text writes: two dates joined by a dash, "to" or "until" make a range, and
  "Tuesdays … weekly from 20 October until 8 December" keeps only the Tuesdays.
- **What is skipped.** Mail header lines (when it was sent is not when anything happens) and chat stamps ("[11:00]").
  Also a date the item says no longer holds ("moved from 13 Nov", "rescheduled from Friday 13 November", "originally
  Thursday 29 Oct").
- **No note at all** for an item marked cancelled, called off or postponed.
- **The item's times.** Its start with the end its text gives, written ranges ("14:00–17:30", "9am-5pm") and single
  clock times.
- **What is said.** A day the request names that the item falls on or spans. When both name a time of day, the overlap
  is added. When both give times and they miss each other, nothing is said: the times show there is no clash, and a
  note would invite one.
- **Only positive findings.** A different day says nothing, so the note never argues an item away.

The note is made only of fixed words, numbers, and weekday and month names, so no source text reaches it (D11, D19).
It sits in brackets after `WHY_TAG`, and `shownText` drops it, so usage tracking does not count Eden's words as the
item's. It reads the first 1,500 characters of the item, at most 8 dates and 6 times. It keeps no state (no isolation
or persistence change) and makes no call.

Earlier attempts this does not repeat:
- D268: constraint-first excerpts, rejected at −2.7. This trial does not reorder or re-cut the item's text.
- D250 and D705: packet-level closing or lead lines, both rejected. This note is per item and factual.

## $0 screen (train1–6, seeds 41–44, shipped coverage)

- Retrieval is unchanged: the funnel reads 295 / 268 with the switch on and off (the note changes no ranking).
- Notes reach the planted fact on 26 of the 281 hidden tasks whose packet holds it, on 6 of the 246 control
  look-alikes handed, and on 19 other items over the 384 neutral tasks.
- Hidden packet bytes are up 0.6% (599,179 against 595,765 over the 514 hidden packets).
- On train1r–6r: 24 of 253 handed planted facts noted, 6 look-alikes.

Two precision fixes came from reading the control packets. A look-alike "moved from 13 Nov" had been noted on its
old date, and a "Canceled:" event had been noted as a clash. That gave the start-day rule, the "moved from" rule and
the called-off rule. Same-day items whose times miss the request's lost their notes too.

## The Pi pair (pre-registered, D1120)

**The rule.** It was committed in the trial's first commit (dcf47d8d5), and amended to two pooled replicates before
any result was read (dcdb71bf1).

**The setup:**
- Pi, arms `both+ask` (the default) and `both~WHY+ask`, paired task by task in one process.
- Haiku 5.5 for the agent and Eden's roles, with a Sonnet 5.5 grader, on Anthropic direct (lab transport, D97).
- Shipped coverage, the market `direct` profile, payload notices and `--tenant-prompt`.
- train1–6 and train1r–6r, seeds 41–44, on the 36 templates where the $0 funnel notes some item, with the hidden,
  control and neutral variants.
- Scripts: `packages/sim/lab/f3/go.sh` (`REP=1`, `REP=2`) and `report.py`. The task sets are in `sets.json`. The
  scripts need the trial's commit, since the switch is deleted.

**The outage.** Replicate 2's reworded half ran into the account's credit outage: HTTP 400 on 36–203 of 216 tasks
a file. Eden's model roles fail open, so even its finished tasks may have run degraded. Those four files are discarded
whole. What follows is replicate 1, plus replicate 2 on train.

| readout (WHY − base, template-clustered 95%) | base | why | difference |
| --- | ---: | ---: | --- |
| **primary**: hidden raised, tasks where the funnel notes the fact | 68/75 | 64/75 | −5.3 pts (−12.8..+0.0) |
| hidden raised, all 36 templates | 305/431 | 304/431 | −0.2 pts (−2.8..+2.3) |
| concerns, control + neutral | 3/862 | 2/862 | −0.1 pts (−0.5..+0.2) |
| packet characters | 1,107,487 | 1,150,150 | +3.9% |

Replicate 1 alone, as first registered, gives a primary of −8.0 pts (−20.8..+0.0). Every cut fails the rule (a lower
bound above 0), and the point estimate is negative on each. Concerns did not move, and the bytes stayed within the 15%
bound.

Spend: $5.25 in all, the 400s included.

**Why it failed:**
1. **Ceiling.** Without the note the agent already raised 91% of the primary facts. Train's clashes are written
   plainly ("Blood test, Thursday 5 Nov, 08:40", against breakfast at 8:30 that day), so the agent does the arithmetic
   unaided. Train has none of H19's silent edits, where the item reads as an ordinary event and the clash is the only
   tell. A suite that cannot show the loss cannot show the fix.
2. **A wrong note hurts.** `support-cover-clash` lost 3 of the 5 primary tasks lost (1 was gained):
   - The request is "Approve Sam's holiday request for 21–31 December".
   - `timeWindow` reads only "31 December" of the range.
   - The item's own clash, "Mark: Fri 18 Dec – Fri 1 Jan", was not joined into a range, because the join pattern
     takes full weekday names only.
   - So the note said "dated Thu 31 Dec, a day the request names", which pointed at the item's line repeating Sam's own
     request, not at the overlapping leave. The agent followed the pointer.

## Round 2: the change line and the clash note v2 on dev20's silent edits (D1122–D1126)

**What was built** (all deleted by D1126; the code is in bf3f577c1):
- `versions.ts`: a store of what changed in an item at its source.
  - It records an edit when a synced copy replaces a synced copy (`ItemCache.onRevised`).
  - It keeps the words the two versions differ by: a mail's header lines aside, cut where three words agree again.
  - Bounds: per tenant and user, in memory, 64 items a user, 4,096 users; an item's change goes with the item, the
    user or a `forget`.
- The packet line it fed read "(Eden: changed at its source on Tue 27 Oct: was 'dep 08:31 ·', now 'dep 06:31 ·')".
- The clash note v2 fixed both of D1121's parser misses, and stayed silent on an item that only repeats the request's
  dates and on requests over more than three days.

**The harness** (kept):
- `HiddenTask.before` holds the planted item as it read before a silent edit.
- `silent.ts` plants that version for the backfill, then swaps the edit in with no notice just before the first request.
- dev20 takes `before` from F8's `dev20xBefore`; `<train>+silent` makes one with revision.ts's fixed rule.
- `--noise-edits N` edits N unrelated items silently in every variant. Without it the concern guard would never see a
  change line on an item that matters to no request.

**The pilot.** Subagent-simulated, pre-registered in D1125; there was no API credit.
- Eden's push packets came from the $0 funnel: dev20 seeds 41–44, the 40 silent-edit templates, `--noise-edits 16`,
  coverage none (dev20's cards are not recorded).
- The harness's own system prompt (data pushed, house rules) went with them to Haiku subagents for one answer each,
  with no tools. Sonnet subagents graded the answers with the harness's grader prompt.
- 1,440 arm-tasks, 265 distinct prompts each answered once, 394 grades. Identical prompts across arms differ by nothing.
- Batches were split by arm, so no subagent saw two arms' versions of a task.
- Tooling: `packages/sim/lab/f3/pilot-{build,grade}.ts` and `pilot-report.py`.

| subagent-simulated pilot | base | CH (change line) | CW (change line + clash note) |
| --- | ---: | ---: | ---: |
| hidden raised | 15/160 | 14/160 | 16/160 |
| hidden raised where the packet held the fact | 15/26 | 14/26 | 16/26 |
| control concerns | 0/160 | 0/160 | 0/160 |
| neutral concerns | 11/160 | 11/160 | 11/160 |
| packet characters | 266,126 | 271,641 | 272,914 |

- **CH − base**: −0.6 pts (−1.9..+0.0, template-clustered; 0 gained, 1 lost). The primary fails.
- **CW − CH**: +1.2 pts (+0.0..+3.8; 2 gained, 0 lost). Its lower bound is not above 0, so the secondary fails too.
- Concerns did not move.

**What the pilot showed.** Of the 26 hidden tasks whose packet held the fact (CH's packets):

| how the fact was handed | tasks | raised |
| --- | ---: | ---: |
| current version, with the change line | 14 | 13 |
| pre-edit copy (drive 7, trips 4, and one more) | 12 | 0 |

- **The change line meets a ceiling.** Where the agent reads the current copy, it raises the fact almost always, with
  the line or without it. Base raised the current-copy facts too.
- **The stale copy is the loss.** The request's lookup answered from the index for sources it did not poll on demand.
  - Making the push wait for its poll (`syncPollBehind` off) still handed 12 stale copies.
  - With `sourceYield` off, 11.
  - Without on-demand polls at all, all 24 handed facts were stale.
- **Caveat: this harness is the hardest case.** The edit lands just before the first request. dev20 dates its edits
  days earlier, and a background tick would have stored those. So the share of stale hand-outs here is an upper
  bound. But any edit inside a source's poll interval before a request takes this path, notice-less sources most of
  all.

## Recommendations

- **Freshness for silently edited items (the lever D1126 points at).** Before a packet hands an item from a synced
  source the request's lookup did not poll, re-read that item by id, or poll that source's newest page, inside the
  push's existing deadline. This is the D126/D211 re-read path, applied to "not polled this request", not only to
  "doubted".
  - Measure it with `<suite>` and dev20 under `--noise-edits`, counting stale hand-outs at $0 first.
  - Then a paired run, with latency and connector calls as its guards.
- **Run the harness with a realistic gap as well.** Edits landing N minutes before the request, with background ticks
  in between, would show how often a real sync already holds the edit.

The earlier recommendations stand, below.


- **Re-test only on a suite whose clashes the agent misses unaided.** F8's dev20 suites (silent edits, clashes) are
  the candidate. Re-test with both parser fixes:
  - day ranges in the request ("21–31 December", "2–8 Nov") in `timeWindow`;
  - short weekdays after a dash in the item's ranges.

  Pre-register a primary restricted to tasks whose base arm misses the fact at a measurable rate.
- **Say nothing when unsure.** A note that names a partial match (the request's day found only in the item's echo of
  the request) is worse than none. Require the noted span not to be the request's own words echoed: a line naming the
  request's subject.
- **Versions.** "Changed on 23 Oct: was 11:00–15:00" needs a per-user store of an item's earlier times across syncs,
  bounded, sanitised, frozen and persisted with the user, with an isolation test. No lab suite edits an item between
  two syncs before its request. Build it only with such a suite (a `--days` world whose planted item is edited
  overnight), or the store cannot be measured.
- **The push check's `on`/`hits`.** F6 noted that the check's reply already names, per item, what of the request it
  lands on, and that this is discarded. It is model text, so it needs `safeLine`, redaction and the data envelope. It
  costs nothing extra, but exists only when the check runs. It is untested here.
