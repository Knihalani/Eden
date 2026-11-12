# F3: saying why a handed item matters to this request

Status: 2026-11-12. Trial `packetWhy` (D1120), RESULT_PENDING.

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

RESULT_PENDING

## Recommendations

RESULT_PENDING
