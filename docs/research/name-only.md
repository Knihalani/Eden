# A name alone is not a need (`quietNameOnly`, D54)

D53's configuration (G) raised the no-model soft fire rate (a delivery on a passing mention of someone, "Leila
Haddad says hi by the way") from 0.218 (F) to 0.299 on the realistic simulation. This note finds where those fires come
from and removes most of them with one general rule, behind a flag, off by default.

## Diagnosis

The simulation report now counts, per delivery path (the injection reason's first part), the soft turns it delivered
on (`byReason[path].softFires`; a turn counts once per path). G, no model, realistic, seeds 41-44:

| path              | delivered | relevant | soft fires |
| ----------------- | --------: | -------: | ---------: |
| sources (sure)    |       397 |      218 |          7 |
| grounded-conflict |        86 |       58 |          4 |
| cache (fast path) |        25 |       13 |          4 |
| fallback          |        60 |       32 |          2 |
| every other path  |       103 |       82 |          0 |

Reading each soft fire's request and items: every one was tied to the request by a person's name and nothing else.
"May Lindqvist says hi" took her lunch and a Notion comment of hers; "Sam Patel recommended a great book" took a Jira
ticket Sam had marked Blocked as a conflict; "Dana Lee just sent me a meme" took the deal where Dana is champion. The
grounded paths (person, occasion, away) already need a second ground (a topic word, an occasion word, a named day) and
fired on none.

## The rule

With `quietNameOnly`, a request that names someone the user's items show taking part (`ItemCache.isPerson`: a From, To
or Cc, an attendee, an owner, by full name or the first name they go by) has its topic computed: its words other than
those people's names and words that only say when. A company, a place or a project it names stays in the topic ("How
much do we owe Pied Piper?" is about Pied Piper). With no model's say, the confident path, the fallback and the conflict
ground then push an item only if something besides the name ties it to the request:

- the item holds a topic word (counted from the cache's index, no rescan), or
- it is on a day the request names, or its text names that day, or
- it holds a reference the request names (`conflict.ts` `namesRef`), or
- the request is an act on someone: an arriving message (D44 grounds it on the sender) or a request in the imperative
  (`isImperative`: "Book a table for me and Sam", "Send Priya a hamper"), where what bears on the person bears on the act.

The last clause came from the funnel: without it, the standing-constraint conflicts the conflict ground was built for
(a friend's allergy when booking dinner, a contact who has left when writing to them) were lost (128 → 113 hidden facts
delivered). `isImperative` is stricter than `isAction`, which takes a scheduling word anywhere ("a great **book** on
negotiation").

No model call, no source call, no dependency. The person names are derived from the per-user party tally the cache
already keeps for `selfOf` (keyed by tenant and user, bounded by the user's items, dropped with them).

## Results

All runs in one session at commit `innov2/precision`, planner on. G as D53; G+ is G with `quietNameOnly`.

Realistic, seeds 41-44:

| config | judge   | recall | stated | precision | soft fires (rate) | hard false fires | calls/lookup | bytes/fact |
| ------ | ------- | -----: | -----: | --------: | ----------------: | ---------------: | -----------: | ---------: |
| G      | none    |  0.408 |  0.366 |     0.601 |      17 (0.299)   |                0 |         7.76 |        496 |
| G+     | none    |  0.407 |  0.367 |     0.639 |       6 (0.086)   |                0 |         7.76 |        469 |
| G      | perfect |  0.647 |  0.604 |     0.950 |           0.062   |                0 |         7.79 |        433 |
| G+     | perfect |  0.649 |  0.605 |     0.954 |           0.045   |                0 |         7.80 |        433 |

Model cost with the perfect judge: $0.02025 per 1,000 turns for both. Per path after (no model): sources 371/216 with 2
soft fires, grounded-conflict 72/59 with 1, cache 24/14 with 3, fallback 58/33 with 0. The soft-turn denominator is
small (about 12 turns a seed), so the rate moves in steps of about 0.02.

Out of sample (profiles never used to design the rule), seeds 41-42, no model: zoo-a soft fire rate 0.284 → 0.134
(F: 0.217) at recall 0.416 → 0.411 and precision 0.614 → 0.645; zoo-b 0.400 → 0.217 (F: 0.367) at recall 0.434 →
0.434 and precision 0.596 → 0.635. Perfect judge: zoo-a recall 0.596 both, precision 0.952 → 0.954; zoo-b recall 0.722
both, precision 0.965 → 0.970. No hard false fire anywhere.

No-model funnel (hidden and held-out 1-4): 148 / 128 / 21 (returned / delivered / decoys) for both G and G+. Eval: the
no-model eval JSON is identical with the flag off (latency only).

## In sample and what is left

The rule was written after reading the realistic profile's soft fires (in sample); zoo-a, zoo-b and the funnel were
measured after. The four soft-mention templates of the simulation are all passing mentions with no topic the user's
items hold; real passing mentions may share a common word with an item ("reply", "hi") and still fire. What still fires
is people the cache does not record as a party (a Jira or Notion actor named only in the body, a deal's champion) and
lowercase names (no entity). The occasion-and-day ground (21 delivered, 9 relevant) is a separate, ambiguity cost on
need turns ("lunch on Monday" with several lunches that day) and fires on no soft turn; it is left as it is.
