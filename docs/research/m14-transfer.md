# M14: making micro models transfer to text written differently from their training data

Status: 2026-11-11, branch `claude/m14-transfer` (data on the side branch `claude/m14-data`, never merged), session
M14, decisions D1020–D1025. Lab only: nothing in a product package imports this work. Simulated and generated data
only; heldout19 was not read or run. Every number below comes from a command run in this session; **[EST]** marks
judgement or arithmetic.

## In plain words

Small models trained on M2's generated worlds looked good on M2 and failed on the sim's hand-written families. M14
built two more generators (G2, written by Sonnet in eight formats; G3, written by templates with no model) and a
screen that trains on all but one generator and tests on the one left out. Three findings:

- **M2's fact-versus-look-alike separation is mostly length.** Length alone picks M2's fact in 94% of tasks, so
  any model screened on M2 can pass by reading length. The screen now reports a length-controlled number, and a
  length-debiased M2 (`m2lb`) removes the cue (length alone 0.511).
- **No training recipe closes the gap on the sim.** Format noise, paraphrase, typed normalisation,
  domain-adversarial training, mixing generators and distillation from M1's 8B teacher were each measured on a
  reference model. None beat training on M2 alone on the sim with an interval clear of zero; normalisation and
  length-balanced subsampling made things worse.
- **What transfers is the screen, not a recipe.** Keep noise and paraphrase (cheap, never significantly worse),
  screen on `m2lb`, G2, G3 and the sim with `logo.py`, and read `twin_hard` with its clustered interval.

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

| Source | Writer                                                                   | Size                                                                             | How it differs                                                                                           |
| ------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `m2`   | Haiku 5.5, four stages (families, world, tasks, revision), M2 v2         | 600 train + 274 val worlds as train (6,485 tasks), 293 test worlds (2,206 tasks) | the sim's email headers, English items, seven request styles                                             |
| `sim`  | hand-written templates (train1–6), seeds 100–109                         | 1,920 tasks over 192 templates; test = 20% of templates by hash                  | one request a task, the sim's base world as background, snippets as the cache holds them                 |
| `g2`   | Sonnet 5.5, one call a world, no family stage (`m14/g2.ts`)              | 280 worlds, 1,115 tasks (215 silent edits)                                       | eight format packs (below), its own five request styles, told that length must not reveal an item's role |
| `g3`   | no model: compositional templates and programmatic formats (`m14/g3.ts`) | 375 worlds, 1,500 tasks                                                          | template text, a date style per world, OCR character noise on 30% of worlds, terse facts                 |

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

| Reason                   | Replies |
| ------------------------ | ------- |
| unparsable JSON          | 9       |
| under two valid tasks    | 6       |
| a fact after its request | 3       |
| truncated                | 1       |
| incomplete               | 1       |

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

| Source  | Length alone: fact ranks above its twin              |
| ------- | ---------------------------------------------------- |
| M2 test | 94.3%                                                |
| G2      | 82.1% (despite G2's prompt asking for length parity) |
| sim     | 68.1%                                                |
| G3      | 66.9%                                                |

So D909's "the item alone separates fact from twin at 0.94–0.95 on M2's" is length. Any micro model screened on M2
alone can pass on it, which is D908's failure made general.

The screen therefore reports `twin_hard`. Only 27 of the first 600 M2 test tasks qualify, against hundreds on the
other sources, so M2's `twin_hard` is read on the whole test split or not at all.

## 4. The recipes (D1023, D1025)

The reference model is `hashnet.py`: hashed word 1–2-grams and character 3–5-grams (2^18 buckets) into a 64-wide
EmbeddingBag, an item head and a pair head, CPU torch, 3 epochs, 2 seeds, each training source capped at 2,000 rows,
600 test tasks a held-out source. Recipes are switches:

- `balance`: weights each training source equally;
- `noise`: token dropout, case and punctuation noise, format noise (quoting, line breaks, OCR swaps);
- `para`: about half the training items swapped for a Haiku rewrite in one of 14 styles (18,476 rewrites, $1.53);
- `norm`: typed placeholders for dates, times, amounts, names and ids before hashing;
- `dann`: a source classifier behind gradient reversal;
- `lenbal`: subsamples training tasks so the fact is longer in half;
- `distill`: soft targets from M1's 8B teacher's scores over M2 v2's pair groups (`teacher-join.ts`).

Held-out `twin_hard` / `fact_at1`, two-seed means (`logo.py summary`):

| Training                                    | sim                          | G2                  | G3            |
| ------------------------------------------- | ---------------------------- | ------------------- | ------------- |
| M2 alone (`from:m2`, today's practice)      | 0.549 / 0.281                | 0.755 / 0.308       | 0.867 / 0.296 |
| M2 alone + noise + para                     | 0.572 / 0.312                | 0.735 / 0.302       | 0.846 / 0.322 |
| `m2lb` alone (§5)                           | 0.628 / 0.235                | 0.765 / 0.313       | 0.846 / 0.299 |
| `logo` balance                              | 0.504 / 0.290                | 0.673 / 0.318       | 0.803 / 0.300 |
| `logo` balance + noise                      | 0.556 / 0.310                | 0.775 / 0.307       | 0.835 / 0.334 |
| `logo` balance + noise + para               | 0.590 / 0.315                | 0.725 / 0.333       | 0.825 / 0.293 |
| `logo` balance + noise + para + distill     | 0.575 / 0.329                | 0.745 / 0.351       | 0.766 / 0.302 |
| `logo` balance + para                       | 0.556 / 0.313                | 0.714 / 0.349       | 0.771 / 0.298 |
| `logo` balance + distill                    | 0.466 / 0.298                | 0.735 / 0.334       | 0.798 / 0.293 |
| `logo` balance + noise + para + norm        | 0.598 / 0.135                | 0.694 / 0.302       | 0.793 / 0.353 |
| `logo` balance + norm                       | 0.511 / 0.219                | 0.694 / 0.293       | 0.808 / 0.327 |
| `logo` balance + dann                       | 0.507 / 0.284                | 0.684 / 0.316       | 0.793 / 0.296 |
| `logo` balance + lenbal                     | 0.436 / 0.181                | 0.622 / 0.211       | 0.798 / 0.255 |
| the held-out source's own train rows (`in`) | 0.38 (one seed, partial run) | 0.47–0.51 (partial) | 0.915 / 0.487 |

Against M2 alone (`logo.py compare --any-mode`, seed-averaged task outcomes, bootstrap over templates or families,
95% interval):

| Training                        | sim `twin_hard`         | sim `fact_at1`              | G2 `twin_hard`          | G2 `fact_at1`           |
| ------------------------------- | ----------------------- | --------------------------- | ----------------------- | ----------------------- |
| M2 + noise + para               | +0.023 (−0.038..+0.108) | +0.031 (−0.018..+0.082)     | −0.020 (−0.061..+0.020) | −0.006 (−0.035..+0.023) |
| `m2lb`                          | +0.079 (−0.008..+0.242) | **−0.046 (−0.084..−0.016)** | +0.010 (−0.020..+0.051) | +0.005 (−0.013..+0.024) |
| `logo` + noise + para           | +0.041 (−0.022..+0.129) | +0.034 (−0.068..+0.134)     | −0.031 (−0.112..+0.051) | +0.025 (−0.027..+0.074) |
| `logo` + noise + para + distill | +0.026 (−0.042..+0.113) | +0.049 (−0.043..+0.144)     | −0.010 (−0.071..+0.061) | +0.042 (−0.008..+0.090) |
| `logo` + para                   | +0.007 (−0.052..+0.059) | +0.032 (−0.053..+0.116)     | −0.041 (−0.133..+0.041) | +0.041 (−0.007..+0.085) |
| `logo` + distill                | −0.083 (−0.273..+0.074) | +0.018 (−0.073..+0.113)     | −0.020 (−0.102..+0.071) | +0.026 (−0.022..+0.075) |
| `logo` + noise + para + norm    | +0.049 (−0.060..+0.167) | **−0.146 (−0.248..−0.047)** | −0.061 (−0.163..+0.041) | −0.006 (−0.058..+0.045) |

On G3, M2 + noise + para against M2 alone: `twin_hard` −0.021 (−0.052..+0.006), `fact_at1` **+0.025
(+0.002..+0.052)**, the one interval above zero in the screen. The sim's `twin_hard` rests on 133 tasks over 16
templates, so its intervals are wide; a gain under about 0.1 cannot be seen there.

Reading:

- **Mixing generators does not beat M2 alone.** The `logo` mixes add G2, G3 (and the sim, for the other folds) to
  a capped M2 and land within noise of M2 alone, below it on G3 (0.825 against 0.867).
- **Noise and paraphrase are the safe default.** Never significantly worse, once significantly better (G3
  `fact_at1`), and free at serving time.
- **Distillation from the 8B adds nothing measurable here.** The teacher's scores cover M2 only, so a student
  distilled on them learns M2's style along with the teacher's judgement.
- **Normalisation hurts ranking** (sim `fact_at1` −0.146 with noise and paraphrase): dates and amounts turned into
  placeholders lose exactly the detail a fact differs from its twin by.
- **`lenbal` and `dann` are rejected.** `lenbal` keeps too few M2 tasks; `dann` changes nothing.
- **In-source is no ceiling for small sources.** The sim's own train templates (about 150) teach less than M2's
  thousands of tasks, so `in` is below `from:m2` on the sim and G2.

The probe (D908's 52 short constraints, `--probe`): the M2-alone and `logo` models name 33–77% of its facts and keep
69–88% of its not-clear items clear (G3's own rows, `in`: 10% and 96–100%). M2 alone + noise + para reads
0.48–0.54 / 0.81–0.85, `m2lb` 0.54 / 0.83–0.87, `logo` mixes with the sim held out 0.33–0.48.

## 5. The length-debiased M2 (D1024)

`m14/debias.ts` pads every item of an M2 world, at one base rate (0.6), with one chunk of role-neutral boilerplate of
its own source: mail signatures, disclaimers, chat filler lines, document furniture, app footers. A coin a task then
picks fact or twin to end longer and gives it the number of chunks the originally shorter of the two needs to
overtake the other by a random margin, so the coin's item carries that padding whichever role it has. Labels are
unchanged: the chunks name no one and carry no constraint.

- Length alone ranks the fact above its twin 0.511 (M2: 0.943); `--model padcue`, the added characters alone, 0.493.
  A first version padded only the item that had to grow and left a padding-amount cue at 0.690.
- Held out itself (`logo`): `twin_hard` 0.869, `fact_at1` 0.188; trained on itself (`in`) 0.955 / 0.440.
- As training data (§4): sim `twin_hard` +0.079 (−0.008..+0.242), sim `fact_at1` −0.046 (−0.084..−0.016), G2 and G3
  level. It is the screen for a micro model's M2 numbers; training on it instead of M2 is a trade, not a win.

## 6. Limits

- One reference model. A larger model (M10/M11/M13's shapes on Modal) may respond to recipes differently;
  `folds`/`grade` exist for that, and Modal was unreachable from this session.
- The sim's held-out `twin_hard` rests on 16 templates. The screen can rank recipes, not certify a small gain.
- G2 had no critic pass; its packs were followed for neutrals and background more than for facts, and length still
  ranks its fact first 82% of the time despite the prompt.
- G3's tasks are grammatical but not always plausible situations **[EST]**.
- The teacher's scores cover M2 v2 only; distillation on G2/G3/sim would need Modal.
- Two OOM kills cut runs on the 4-core container; each was re-run, at most three folds at once.
- heldout19 was not read or run; nothing here is a held-out-suite number.

## 7. Spend and reproduce

Anthropic **$20.31** of $40: G2 $18.78 (Sonnet 5.5, 300 calls with the pilot), paraphrases $1.53 (Haiku 5.5). Modal
$0. Every training run was CPU in the container.

```bash
# data: git show origin/claude/m14-data:packages/sim/lab/m14/data/README.md (M2 slices from claude/m-synth-data)
bun packages/sim/src/lab/m14/logo-export.ts synth g2-worlds.jsonl --src g2 --out .local/m14/logo/g2.jsonl
bun packages/sim/src/lab/m14/debias.ts m2-test-worlds.jsonl --out m2lb-test-worlds.jsonl
L=.local/m14/logo; PY=.local/m14/venv/bin/python
SRC="--source m2=$L/m2-train.jsonl:$L/m2-test.jsonl --source sim=$L/sim.jsonl"
SRC="$SRC --source g2=$L/g2.jsonl --source g3=$L/g3.jsonl"
$PY -I packages/sim/lab/m14/logo.py run --model lengthcue $SRC --modes logo --seeds 1
LOGO_THREADS=1 $PY -I packages/sim/lab/m14/logo.py run --model hashnet --recipe balance,noise,para $SRC --modes logo \
  --seeds 1,2 --epochs 3 --cap 2000 --max-test 600 --para .local/m14/para.jsonl \
  --probe packages/sim/lab/m3r/short-constraints.jsonl --out .local/m14/r.json
$PY -I packages/sim/lab/m14/logo.py compare baseline.json .local/m14/r.json --any-mode --metrics twin_hard,at1
```
