# M14: making micro models transfer to text written differently from their training data

Status: 2026-11-11, branch `claude/m14-transfer` (data on the side branch `claude/m14-data`, never merged), session
M14, decisions D1020–D1026. Lab only: nothing in a product package imports this work. Simulated and generated data
only; heldout19 was not read or run. Every number below comes from a command run in this session; **[EST]** marks
judgement or arithmetic.

## In plain words

RESULTS_SUMMARY

## 0. The problem

Each micro model of the day looked strong on M2's synthetic worlds and failed on the sim's hand-written families:

- M3's tagger read length (D908);
- H1's ranker never came near its bar (D909);
- M6's trimmer kept 97.8% of facts on M2 test and 73.2% on the sim (D920);
- M3b's supersession net cut stale items 61% on M2 test and 0% on hand-written revisions (D914).

Real users' text will match neither generator. M14 built:

- more generators;
- a standard screen that trains on all but one generator and tests on the one left out;
- a measurement of which training recipes close the gap.

## 1. Four sources (D1020)

A **source** is one way of writing tasks. All four share M2's task schema and construction labels:

- a request in several phrasings;
- a planted fact that changes what the agent should do;
- its all-clear look-alike twin;
- neutral items on the same topic;
- the rest of the world, which is unrelated.

| Source | Writer | Size | How it differs |
| --- | --- | --- | --- |
| `m2` | Haiku 5.5, four stages (families, world, tasks, revision), M2 v2 | 600 train + 274 val worlds as train (6,485 tasks), 293 test worlds (2,206 tasks) | the sim's email headers, English items, seven request styles |
| `sim` | hand-written templates (train1–6), seeds 100–109 | 1,920 tasks over 192 templates; test = 20% of templates by hash | one request a task, the sim's base world as background, snippets as the cache holds them |
| `g2` | Sonnet 5.5, one call a world, no family stage (`m14/g2.ts`) | 280 worlds, 1,115 tasks (215 silent edits) | eight format packs (below), its own five request styles, told that length must not reveal an item's role |
| `g3` | no model: compositional templates and programmatic formats (`m14/g3.ts`) | 375 worlds, 1,500 tasks | template text, a date style per world, OCR character noise on 30% of worlds, terse facts |

**G2's packs** (one per world, cycling, 31–38 worlds each):

- `forwarded`: email chains with quoting, headers, signatures and disclaimers, the deciding detail sometimes in a
  quoted message;
- `chat`: lowercase chat with abbreviations, typos and timestamps;
- `ics`: raw iCalendar;
- `crm`: CRM and issue-tracker field dumps;
- `pdf`: PDF-extracted text with hard breaks, hyphenation and page furniture;
- `apps`: bank, health, school and household notifications and terse notes;
- `foreign`: 35 worlds wholly in German, French, Spanish, Italian, Portuguese or Dutch, items included (M2 had other
  languages only in requests);
- `short`: one-line items, with long background.

**G2's request styles** are none of M2's seven:

- voice-dictated;
- typed fast with typos;
- formal;
- buried in a message about two other things;
- two to five words.

G2's quality was checked by reading the 8-world pilot (one world per pack) and a sample of the 280. It had no critic
pass, unlike M2. Two pilot faults were fixed before the run:

- four of eight personas lived in one city: a region seed fixes it;
- facts ignored the pack's format: the prompt now says the format applies to facts and twins too.

Assembly dropped 20 of 300 replies:

| Reason | Replies |
| --- | --- |
| unparsable JSON | 9 |
| under two valid tasks | 6 |
| a fact after its request | 3 |
| truncated | 1 |
| incomplete | 1 |

**G3** writes each task from a subject (30: a booking, a payment, a school trip, a renewal and the like) and an
archetype (all 16 of M2's taxonomy), each with a fact template and a twin template under one decoy kind. Every slot
is drawn once per task, so the request, fact, twin and neutrals name the same things. The output goes through one of
ten formats by source:

- plain, forwarded or quoted email;
- SMS lines;
- iCalendar;
- CRM fields;
- PDF wrapping;
- app alerts;
- tickets;
- notes.

G3 is deterministic in the world index. One label leak was found and removed before any run: a title option printed
the archetype's name. Its weakness is coherence: a schedule clash against a passport renewal is grammatical and
dated, but not a situation anyone has **[EST]**.

## 2. The leave-one-generator-out screen (D1021)

`packages/sim/lab/m14/logo.py`, with `logo_core.py` (stdlib only, unit-tested in the modal suite) and
`logo-export.ts`.

**Rows.** One line per task: requests, fact, twin, neutrals and 24 unrelated items from the same world, every text
through the engine's `sanitizeItem`. A within-source split keeps a template (sim) or family (synth) whole; M2 keeps
its own cluster split.

**Modes.**

- `logo`: train on every other source, each capped at 2,000 rows, so M2 does not swamp the mix.
- `in`: train on the held-out source's own train rows. This is the in-source ceiling.
- `from:m2`: train on M2 alone, which is today's practice.

**Numbers per held-out source.**

- `twin`: the fact beats its twin, item alone. This is the D908/D909 measurement.
- `twin_hard`: the same on tasks whose twin is at least as long as the fact (§3).
- `twin_req`: the fact beats its twin for the request.
- `fact_at1`: the fact ranks first among its task's items and 24 unrelated ones, per request.
- `relevance`: AUC of "bears on the request", own items against unrelated ones.

**A model** plugs in as `make(cfg) → fit(rows), score(rows)`. A model trained elsewhere (Modal) uses `folds` (fold
files) and `grade` (its scores back). docs/LAB.md 1l has the commands.

## 3. M2's twin separation is mostly length (D1022)

`--model lengthcue` scores an item by its character length, the direction learned from training. Commands are in §7.
It ranks the fact above its twin:

| Source | Length alone: fact ranks above its twin |
| --- | --- |
| M2 test | 94.3% |
| G2 | 82.1% (despite G2's prompt asking for length parity) |
| sim | 68.1% |
| G3 | 66.9% |

So D909's "the item alone separates fact from twin at 0.94–0.95 on M2's" is length. Any micro model screened on M2
alone can pass on it, which is D908's failure made general.

The screen therefore reports `twin_hard`. Only 27 of the first 600 M2 test tasks qualify, against hundreds on the
other sources, so M2's `twin_hard` is read on the whole test split or not at all.

RESULTS_SECTIONS
