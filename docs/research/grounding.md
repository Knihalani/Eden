# Grounding requests in people and time (D44)

Status: 2026-10-29. Simulation (planner on, `quality-cli`), the eval, and a private sample of the owner's real mail
and calendar (read-only, not in the repo). No live model run (the key's spend limit).

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

## Results

Simulation against main, planner on (recall gain per seed with a 95% interval):

| Mix | Seeds | No model: recall, precision | Perfect judge: recall, precision |
|---|---|---|---|
| zoo-tune | 1–10 | 0.257 → 0.271 (+2.6, −0.8–6.0), 0.594 → 0.611 | 0.482 → 0.492 (+1.8, −1.0–4.6), 0.819 → 0.818 |
| held-out A | 31–40 | 0.260 → 0.281 (+3.8, 1.6–6.0), 0.614 → 0.627 | 0.471 → 0.474 (+0.6), 0.805 → 0.809 |
| held-out B | 31–40 | 0.287 → 0.306 (+3.4, 1.3–5.5), 0.544 → 0.547 | 0.578 → 0.585 (+1.1), 0.773 → 0.770 |
| realistic | 31–40 | 0.262 → 0.283 (+3.8, 1.6–6.0), 0.614 → 0.630 | 0.458 → 0.466 (+1.4), 0.805 → 0.807 |

No hard false fire before or after (1,414 and 1,316 silent turns per row). The soft-fire rate moved both ways (no
model: A 0.183 → 0.195, realistic 0.185 → 0.180; judge: zoo-tune 0.174 → 0.186). With the judge the changes are
within noise: grounding is the no-model path, and the judge only sees a day's events as extra candidates.

The owner's real data, same harness and clock for both (one user per request, so an instant burst of 25 requests
does not hit the per-source rate limit): main 8 of 15 at precision 0.80; grounding 14 of 15 at precision 0.933
(strict labels; the one extra item was a booking email beside the meeting it booked); 0 of 16 false fires either
way. The remaining miss asked for a booking reference by airline name, a single word. Fifteen requests labelled by
the person who built the rules are a sanity check, not a tuning set: the rules were chosen on the simulation.

The eval is identical to main apart from latency (its scenarios carry no people or start fields).

## Limits

- Dates are compared as calendar days: an item's day from its own offset, the request's from the event clock's UTC
  day. Near midnight in a far timezone this can be a day off.
- Date phrases are English; "next Sunday" is the next Sunday, not the one in next week.
- A time listing needs a connector that lists by time: `McpSource` fills a tool's date arguments
  (`startTime`/`endTime` and similar) with the window, and sends no words. Measured on static and simulated sources
  only.

## Reproduce

```bash
bun packages/sim/src/quality-cli.ts --profile realistic --seed 31 --planner --judge none   # see byReason
```
