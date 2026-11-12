# F3: saying why a handed item matters to this request

Status: 2026-11-12. Trial `packetWhy` (D1120) rejected on its pre-registered rule and deleted (D1121; code and tests in
dcf47d8d5).

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

| readout (WHY − base, template-clustered 95%) | base | why | difference |
| --- | ---: | ---: | --- |
| **primary**: hidden raised, tasks where the funnel notes the fact | 83/91 | 79/91 | −4.4 pts (−12.8..+2.2) |
| hidden raised, all 36 templates | 361/512 | 359/512 | −0.4 pts (−3.1..+2.4) |
| concerns, control + neutral | 4/1010 | 4/1010 | +0.0 pts (−0.3..+0.3) |
| packet characters | 1,338,042 | 1,385,897 | +3.6% |

The primary needed a lower bound above 0, and its point estimate is negative: rejected. Concerns did not move, and
the bytes stayed within the 15% bound. On the primary tasks, 2 were gained and 6 lost. Across all hidden tasks the
pair split 29 gained and 31 lost, which is noise.

Spend: $5.25 in all, about 1,700 task-arms a replicate.

**Why it failed:**
1. **Ceiling.** Without the note the agent already raised 91% of the primary facts. Train's clashes are written
   plainly ("Blood test, Thursday 5 Nov, 08:40", against breakfast at 8:30 that day), so the agent does the arithmetic
   unaided. Train has none of H19's silent edits, where the item reads as an ordinary event and the clash is the only
   tell. A suite that cannot show the loss cannot show the fix.
2. **A wrong note hurts.** `support-cover-clash` lost 4 of the 6:
   - The request is "Approve Sam's holiday request for 21–31 December".
   - `timeWindow` reads only "31 December" of the range.
   - The item's own clash, "Mark: Fri 18 Dec – Fri 1 Jan", was not joined into a range, because the join pattern
     takes full weekday names only.
   - So the note said "dated Thu 31 Dec, a day the request names", which pointed at the item's line repeating Sam's own
     request, not at the overlapping leave. The agent followed the pointer.

## Recommendations

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
