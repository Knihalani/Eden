# Grounding requests in people and time (D44)

Status: 2026-10-29. Simulation (planner on, `quality-cli`), the eval, and a private sample of the owner's real mail
and calendar (read-only, not in the repo). No live model run (the key's spend limit). Re-measured after an
independent review, on fresh held-out seeds.

## The problem

On the owner's real data (47 calendar events, 50 mail threads; 15 requests a personal assistant might get, labelled
by hand, and 16 turns where nothing in the sources helps), Eden with no model delivered 8 of 15 needed items at
precision 0.80, with no false fire. The misses were of one kind: the right item was a candidate, but the request
shared too few words with it to clear the no-model bar (D6, D36). "Email <a person> to find a new time to meet"
shares only the name with "<user> and <person>" on the calendar; "what's on my calendar this Sunday?" shares
nothing with the event that day.

## What grounding reads

Not more word matching: the structure a connector already reports.

- **Who takes part.** `McpSource` keeps attendees, organiser, sender and recipients as `meta.people` ("Display Name
  <email>" entries, the user's own left out). A full name in the request matches a participant by identity: every word
  in the display name, or in the email address; an event's title naming the person as a phrase counts (calendar
  titles name the other party). One-word names never match: too common to stand for a person.
- **When.** `meta.start` keeps an event's start as the server gave it. Relative and explicit dates in the request
  resolve against the event's own clock to calendar days; "the next X" asks for the earliest upcoming one.
- **What for.** A request about meeting someone (moving plans, running late, "still on for lunch?") is about an event
  with them, never another thread they are on; any other request about a person also needs a word of its topic.

## Measured on the way

Each branch's precision was read from the simulation's new per-reason breakdown (`byReason`, zoo-tune seeds 1–10,
no model), against D36's fallback at 0.54–0.59:

| Version | Person only | Person + day | Named event on the day | Whole day |
|---|---|---|---|---|
| first: any item with the person | 73/148 (0.49) | 3/3 | 5/8 | 0/5 |
| meeting requests need an event; others a topic word | 81/95 (0.85) | 4/4 | 6/9 | 0/4 |
| whole day only when the request names nobody | 80/94 (0.85) | 4/4 | 6/9 | 0/1 |

The first version delivered "Contract template" for "running a bit late, still ok to meet?" from a colleague: who is
named does not say which of their items. Two engine bugs also showed up on the real data and are fixed: grounding
read only the judge's six candidates (a day's events rank after every word match), and the near-duplicate filter
removed every occurrence of a recurring event but one.

## Review round

An independent review found false matches the first version allowed, each now a test: a name inside an address's
domain ("Mark Hall" and marketing@townhall), "last Friday" read as the coming one, "next steps" read as a time, "the 2
may be late" read as a date, a common title word ("Weekly Report" and "Weekly mentoring"), and days taken in UTC
rather than the user's own offset (now the offset most of their events carry). A time listing now goes only to
sources that list by time (`Source.listsByTime`) and bypasses the planner, which made no call for a request with no
words; a day's cached events are capped at 30 before scoring.

Re-measuring then showed two branches below the fallback's precision, both on "What's on the agenda with Elena this
week?" (held-out seeds 31–36, read for this):

| Branch | Before (zoo-tune 1–10, held-out 31–40) | After (zoo-tune 1–10, held-out 31–50) |
|---|---|---|
| Whole day: a calendar question with no entity | 0/32 | gone: a lowercase or one-word name ("with sam") is no entity, so the rule now needs a request of nothing but time and calendar words, the listing's own test |
| Named event: a first name in the title ("Robin / Elena 1:1") | 15/40 (0.38) | 29/39 (0.74): a first name alone names an event only for a meeting request ("push coffee with Ahmed next week") |

Because seeds 31–36 were read, fresh seeds 41–50 are the held-out set below.

A second review round found more false readings, each now a test: "next" read as a time in "your next payment is
due" (now only "next" followed by an event: a meeting, call, lunch, talk, or "next on my calendar"), which grounded a
Globex event from a Globex invoice; a mail tool's `since`/`before` counted as a calendar (now only an event range,
`start`/`end` or `timeMin`/`timeMax`, makes a source list by time); any past verb moving a weekday back ("Was the
meeting moved to Friday?" is this Friday; now only a past verb governing the weekday, "we met on Monday"); "the 31st of
February", an ignored explicit year, "2 dec ideas" read as a date, and "next weekend" read as this one. Every
simulation row below was unchanged by these fixes.

## Results

Simulation against main (#182), planner on, the final tree. Recall gain is per seed with a 95% interval:

| Mix | Seeds | No model: recall, precision | Perfect judge |
|---|---|---|---|
| zoo-tune | 1–10 | 0.257 → 0.271 (+2.6, 0.6–4.6), 0.594 → 0.618 | identical |
| held-out A | 41–50 | 0.239 → 0.248 (+1.7, −1.1–4.5), 0.571 → 0.585 | identical |
| held-out B | 41–50 | 0.259 → 0.280 (+3.7, 1.6–5.8), 0.529 → 0.548 | identical |
| realistic | 41–50 | 0.240 → 0.250 (+1.7, 0.6–2.8), 0.576 → 0.594 | identical |

"Identical" means equal recall, precision, soft-fire rate and model calls per turn (realistic 41–50: 0.192 both):
grounding is the no-model path, and adds no model call. No hard false fire on any row (1,414 silent turns on
zoo-tune, 1,470 per held-out row). Soft-fire rate (turns labelled "better silent" that fired): A 0.223 → 0.217, B
0.313 → 0.329, realistic 0.170 → 0.179.

Precision per branch, no model, pooled over each mix's seeds (zoo-tune 1–10, held-out 31–50), against D36's fallback
at 0.60–0.65 and source deliveries at 0.53–0.60:

| Mix | Person | Person + day | Named event on the day |
|---|---|---|---|
| zoo-tune | 65/83 (0.78) | 8/8 | 2/3 |
| held-out A | 135/185 (0.73) | 6/7 | 6/9 |
| held-out B | 152/238 (0.64) | 10/10 | 13/16 |
| realistic | 138/185 (0.75) | 4/4 | 8/11 |

The person branch's misses on B are mostly an item from the same person that shares topic words but is not the one
labelled (a "Contract template" they own for "Legal is asking for the order form"); left as is.

The owner's real data, same harness and clock for both (one user per request, so an instant burst of 25 requests
does not hit the per-source rate limit): main 8 of 15 at precision 0.80; grounding 14 of 15 at precision 0.933
(strict labels; the one extra item was a booking email beside the meeting it booked); 0 of 16 false fires either
way, unchanged by the review round. The remaining miss asked for a booking reference by airline name, a single word.
Fifteen requests labelled by the person who built the rules are a sanity check, not a tuning set.

The eval's existing scenarios are identical to main apart from latency (they carry no people or start fields). A new
scheduling scenario, `people-and-days`, carries them: an email to a named person finds the meeting with them, a
Sunday question finds that day's event, and a Globex invoice's "next payment" and "the agenda with elena this week"
stay silent. Main delivers 0 of 2, grounding 2 of 2, with no false fire.

Cost per event, measured with a micro-benchmark: reading a request's dates 3–4 µs; the scan for a day's events
156 µs over a full cache (2,000 items per user), run only for a request that names a day; matching a name against an
item's participants about 2.6 µs per candidate.

## Limits

- Dates are compared as calendar days: an item's day from its own offset, the request's at the user's offset (the
  one most of their events carry). An event stored in another offset than the user's can be a day off.
- Date phrases are English; "next Sunday" is the next Sunday, not the one in next week.
- A time listing needs a connector that lists by time: `McpSource` fills a tool's date arguments
  (`startTime`/`endTime` and similar) with the window, and sends no words. Measured on static and simulated sources
  only.
- One-word names never ground a person; a first name grounds an event only for a meeting request.
- A past verb moves a weekday back only with at most one word between: "what did we discuss on Monday" is the coming
  Monday. "Next" counts when an event word follows within three words, so "your next payment for the coffee machine"
  still asks for an event; a single shared title word then needs a named day, which keeps that narrow.
- An arriving message that names a day and shares an uncommon word with that day's event grounds it ("Globex
  Ventures: payment due on 12 November" finds "Globex <> Robin" that day): intended, and the branch's remaining
  false-fire risk.

## Reproduce

```bash
bun packages/sim/src/quality-cli.ts --profile realistic --seed 31 --planner --judge none   # see byReason
```
