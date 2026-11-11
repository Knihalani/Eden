# M9: a per-user alias resolver (role → person, place → category, object → governing item)

Status: 2026-11-11, branch `claude/m9-alias`, session M9 (decisions D950–D951). **Stopped on its ceiling** (D950):
nothing was trained beyond the screen, nothing wired. Simulated data only; heldout19 not read or run. Spend:
Anthropic $0.129 (days cards, ledger `.local/m9/ledger.jsonl`), Modal $0. Every number below comes from a command
in this note; the one held-out read of a generator (not of a frozen candidate) is labelled as such.

## 0. The idea

M5 (D910–D912) found the facts Eden still misses mostly share no word with the request: "our usual babysitter" →
Megan, "Dubai" → a pause on international trips, a hire car → the expired licence. M9's idea: learn each user's own
links from their own items at ingest (role → person, nickname → name, person ↔ organisation, place → category,
object → the items that govern it), and at request time add the linked items before the shipped pool. Learning is per
user only; the one shared resource tried was a general gazetteer.

**Pre-registered (0bb1952d):** held-out facts @5 at least +8 points over the shipped pool, decoys @5 rising no faster
than facts, neutral packets not up; then a Pi pair. The test of the idea came first: a **ceiling**. For each
candidate generator, of the facts outside the shipped pool's first five, how many does it put in its first K new
items? A perfect scorer could front exactly those, so no learned model on that generator can gain more.

## 1. Candidates screened (`packages/sim/lab/m9/`, $0)

`links.py` builds one user's link state from their items: people from mail headers, Slack lines, attendees, CRM
contacts and signatures; person ↔ organisation from CRM, signatures and e-mail domains matched to account names;
role → person from a closed role lexicon co-occurring with a person's first name in a sentence (or a CRM title);
nicknames through a general diminutive table and first-name prefixes; rule-bearing items by cue words; an inverted
index. `screen.py` fronts a generator's best item (`--front`), `oracle.py` and `oracle_shared.py` give ceilings,
`ceiling.py` counts two-hop evidence. Fit = train1–4 and train1r–4r; held out = train5–6, train5r–6r, longtail.

**Fronted directly (fit, 1,024 hidden and 1,024 control requests; shipped facts @5 662, decoys @5 639):**

| # | generator | facts @5 | decoys @5 |
|---|---|---|---|
| C1 | nickname → person (Jen → Jennifer) | +0 | +0 |
| C1b | person ↔ organisation | −4 | +6 |
| C1c | role → person (co-occurrence in the user's items) | +0 | −2 |
| C1d | entity pivot (a named person's items, ranked by the request's words) | +1 | +3 |
| C2 | rare-term spreading activation, two hops (df ≤ 15) | −11 | +3 |

**Ceilings: misses reached in a generator's first 10 new items (a perfect scorer's gain):**

| setting | facts gained | twins gained |
|---|---|---|
| short worlds, fit (union of C1–C2) | 65 of 362 misses, **+6.3 points** | 65 of 385, +6.3 |
| short worlds, held out (generator read, not a frozen candidate) | 27 of 219, **+4.4** | 49 of 282, +8.1 |
| days worlds, 8 users (seeds 41–48, live cards), fit / held | 0 of 17 (+0.0) / 1 of 12 (+2.3) | 1 of 16 / 2 of 14 |
| **M2 v2 test** (293 generated personas, one a user, their own people and background items) | 89 of 758, **+4.0** (+4.4 at K = 100) | 139 of 931, +6.3 |

Shared bridges do not lift it: a term-pair table learned on fit templates (M3's qexpand recipe) reaches 75 of the 219
held-out misses in its first 10 new items against plain BM25's 70, and twins 90 → 97. A world gazetteer
(`geonamescache`, cities over 150,000 and countries; lab-only, not added to any package) finds a foreign place in the
requests of 4 fit templates (Lisbon, Dubai, Toronto) of 362 misses.

**Two Haiku helper sessions (fit only, $0)** replicated the fit ceiling exactly (65 and 65) and tried three more
generators. (a) Later items in the same thread or from the same sender: +8 facts and +14 twins over the union at
K = 10. (b) Date-anchored availability: +0 facts and +13 twins. (c) Rule items that share a person with the request's
rare-term seeds: +7 and +12 at K = 10, +17 and +10 at K = 30. A learned scorer over 22 features of the union's
candidates (logistic regression, and a 16-unit sign MLP with a straight-through estimator, two folds by suite)
captured almost none of the ceiling. Test folds: facts 344 → 342–347 and 318 → 310–318; decoys 297 → 295–307 and
342 → 339–345.

## 2. Why it stops (D950)

- **The evidence is not in the worlds.** In the sim, a leap's link is written only in the fact itself. In train2
  seed 41, "babysitter" appears in no item; Megan exists only as the fact's sender. "Ethan Brooks" (train4) appears
  only as "Ethan" in the fact. Steve the landlord's rule about pipes is in the fact alone. Two-hop paths through rare
  words exist for 205 of 362 fit misses, but just as often for twins (174 of 385), and they reach many other items.
- **M2 v2 was the fair test, and it agrees.** Its worlds were generated independently, with personas, named
  relations ("my PhD supervisor") and background items. Even so, a perfect scorer over every per-user generator
  gains +4.0 points of facts and +6.3 of twins.
- **Twins travel with facts.** A twin shares the fact's people, thread and words (a cleared NDA, CP-2201 for
  CP-2210, the garden-waste debit). Any link that reaches the fact reaches its twin, so the decoy clause fails
  before the facts bar.
- **What remains reachable is ranking, not aliasing.** Plain BM25 over the whole world puts 70 of the 219 held-out
  misses in its first 10 new items. That is the pool's ordering, M3's ground (D913: offline overstated live).

No variant was frozen, so no held-out read of a candidate was made, and no Pi pair was run. Speed and size, measured
on the screen's Python only: link building 0.14 ms an item, request 0.05–0.3 ms. A compact encoding of one user's
link state (65 people, 2,138 postings, about 200 role and 40 organisation links) would be about **7 KB [EST]**.

## Reproduce

```bash
unset OPENROUTER_API_KEY
bun run funnel --suite train,reworded,longtail --seeds 41,42,43,44 -- --neutral \
  --pool-dump .local/m9/f-pool.jsonl --corpus-dump .local/m9/f-corpus.jsonl           # $0, about 40 s
python3 -I packages/sim/lab/m9/screen.py --corpus .local/m9/f-corpus.jsonl --pool .local/m9/f-pool.jsonl --hyp hop
python3 -I packages/sim/lab/m9/oracle.py --corpus .local/m9/f-corpus.jsonl --pool .local/m9/f-pool.jsonl \
  --only fit --hyp hop,pivot,porg,nick,role --rare 30 --seeds 10 --bridges 20
# M2 v2 test (side branch claude/m9-data, gunzip into .local/m2/synth/worlds/), 30 seeds at a time (memory):
bun run funnel --jobs 1 --suite synth-test --seeds 0,…,29 --blind -- --pool-dump P --corpus-dump C
```
