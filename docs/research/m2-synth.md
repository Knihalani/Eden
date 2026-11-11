# M2: a synthetic-world factory for the checker (M1) and the retriever (M3)

Status: 2026-11-11, branch `claude/m2-synth`, session M2. Decisions D880–D884. Lab only: nothing in a product package
imports this work. No held-out suite was read or used: families were generated from an archetype list, and the only
suites compared against were train1–6 (by their planting functions, imported one by one, not through the registry).
Every number below comes from a command run in this session; **[EST]** marks judgement or arithmetic.

## In plain words

- **The problem.** The distilled checker of I1/I2 could not tell a planted fact from its all-clear twin on templates
  it had not seen (D491): 154 hand-written templates, one fact-and-twin pair each, were too few.
- **What M2 built.** A factory that writes thousands of synthetic users with Haiku 5.5. Each user has mail, calendar,
  documents, chat, CRM and rarely used sources (texts, WhatsApp, notes, to-dos, bank, health app, files, tickets,
  school app, household app). Each user also has six to eight tasks in the train suites' format: requests in many
  phrasings, a planted fact, its look-alike twin, and neutral items. Labels come from how each item was made, never
  from a model's judgement.
- **What came out.** `v2` holds 2,695 worlds (train/val/test 2,128/274/293), 20,083 tasks over 3,513 scenario
  families, 156,633 requests and 8.19 million labelled (request, item) pairs: 156,633 `changes`, 452,684 `clear`
  and 7.58 million `unrelated`. It is published on the Modal Volume `eden-synth`, with 196,171 pair groups for M1
  beside it. [DATASHEET.md](../../packages/sim/lab/synth/DATASHEET.md) has every count. It was published in stages
  for M1 and M3: `v0` (270 worlds), then `v1` (1,810), then `v2`.
- **How good.** A blind Sonnet audit and my own hand reading put about one task in seven with at least one wrong
  label. The fact itself is wrong in about 2% of tasks. The rest is almost all a look-alike or "neutral" item that
  still bears on the request. A revision pass by the writer roughly halved the confirmed errors.
- **Cost.** $35.10 of the $60 Anthropic cap, or $0.0109 a valid world for generation. The Batch API was meant to
  halve that, but its queue did not start within the session, so most calls were direct.
- **The splits.** Train, validation and test are split by family cluster, so test templates are ones no train world
  saw: the generalisation D491 failed at.

## 1. What a world is

A world (`schema.ts`, one JSON line) is one synthetic user:

- `persona` (name, email, city, job, household) and `people`;
- `items`: about 26 background items, plus four or five a task (fact, decoy, one to three neutrals). Each item has
  `source`, `kind`, `title`, `text`, `at` (epoch ms), `meta`, and `revisionOf` for a silent edit;
- `tasks`, each with `family`, `area`, `archetype`, `timing`, `decoyKind`, `rare`, `detail` (the hidden
  consideration, as `HiddenTask.detail` reads it), `fact`, `decoy`, `neutrals` and `requests`
  (`style`, `lang`, `text`, `at`).

The axes (`taxonomy.ts`) are these:

- **8 life areas:** work, family, health, money, travel, home, admin, social.
- **16 archetypes:** schedule clash, already done, limit exceeded, prerequisite missing, rule forbids, person
  unavailable, plan changed, terms changed, commitment penalty, preference or constraint, deadline shift, sensitive
  situation, safety risk, wrong target, blocked dependency, better route.
- **5 decoy kinds:** resolved, other entity, other period, already met, superseded.
- **4 timings:**
  - static: the fact is already there;
  - silent: an item edited in place with no notification, whose decoy is the pre-edit revision;
  - late: the fact arrives the same day, after the request;
  - multi-day: the fact lands between the first request and a follow-up two days later.
- **Request styles:** imperative, "Should I…", "I need to…", "We should…", a question, chatter, terse, plus
  "foreign" (one of 8 languages, half the tasks) and "follow-up" (multi-day tasks).

## 2. The pipeline (`gen.ts`)

1. **Families.** One call per (area, archetype, angle). Haiku writes 14 abstract scenarios with no names: the
   situation, the request, the fact, the decoy, the decoy kind, and the natural source. Run: 256 calls, 3,607
   families, $0.50.
2. **Plan.** The plan is deterministic in the world's index:
   - the split, from a hash of the world's index;
   - one family per area, drawn from that split, least used first;
   - the timing (15% each of silent, late and multi-day);
   - the fact's source: about 30% rare. A family's own rare source is kept 40% of the time, and a common source
     moves to a rare one 12% of the time; in the pilot, keeping every family's own choice gave 64% rare;
   - a non-English phrasing half the time;
   - persona seeds: region, age, household, work and initials.
3. **World.** One call writes the persona, 12–18 people and 26 background items. The call names the world's eight
   scenarios as reserved topics the background must stay off; the prompt explains why.
4. **Tasks.** One call per task, given the persona, the people, the family, the timing with exact dates, the
   source, and the language. Times come from the plan, not from the reply.
5. **Revision (D883).** One call per task re-reads the fact, the decoy and the neutrals against the audit's fault
   list (below) and rewrites what fails.
6. **Assembly.** Assembly turns each reply into a world:
   - emails get headers;
   - kinds follow from the source;
   - times are clamped;
   - an item, task or world that fails the schema checks (references, timing shape, weekday against date) is
     repaired by dropping it;
   - a world needs at least six of its eight tasks.

Both runners book every call on the spend ledger (`.local/m2/ledger.jsonl`, cap $60) and store each reply under its
key, so a restart resumes. The direct runner is a concurrency pool; the batch runner uses the Message Batches API and
reserves its worst case before sending. Haiku's malformed JSON is repaired:

- an early close of the top-level object (`]}, "items"`);
- stray closers at the end;
- an answer split over two objects.

Refusals (about 20% of world calls in the pilot, when it read "reserved topics" as hiding test cases) fell to a few
once the prompt said why. Those that remain are re-asked, at most twice.

## 3. Deduplication and splits (D882)

- **Against the train suites.** For each family, the content-word Jaccard of its request and fact against each
  train1–6 template's request and detail. A family at or above 0.20 is dropped: 22 of 3,607. The top hits were real
  near-copies, for example a key-safe code "4471" for a cleaner, a lamb dinner with newly vegetarian guests, and a
  matinee needing step-free seats. Each assembled task's request and fact are also compared by word-trigram Jaccard
  against every train request, fact and decoy; a task at or above 0.25 is dropped (0 in v1).
- **Against each other.** A family at or above 0.33 of an earlier one is dropped (60). Families at or above 0.25 share
  a cluster: 2,935 clusters, the largest holding 146 families.
- **Splits.** A cluster's hash fixes its split (80/10/10), and a world takes every family from one split. The Modal
  validation (`synth_store.py`) checks that no family, cluster or exact request text crosses splits: v0 and v1 were
  both clean.
- **Limit.** The checks are lexical, so a paraphrase can pass them. Thresholds were set by reading the top pairs (the
  0.23–0.31 band against train was clearly near-copies; 0.25 between families was related but distinct).

## 4. Quality (D883)

**Critic.** `critic.ts` shows a model one request and five shuffled items: the fact, the decoy, a neutral item,
another task's fact, and a background item. The model labels each item CHANGES / CLEAR / UNRELATED and says whether
the request gives the fact away. It never sees the construction. Its labels are a check on the data, not ground
truth.

| Run | Critic | Tasks | Fact = CHANGES | Decoy = CLEAR | Neutral CHANGES | Other task's fact = UNRELATED | Disputed tasks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pilot | Haiku | 300 | 0.957 | 0.590 | 6% | 0.963 | 92 |
| v2 (prompt fixes) | Haiku | 300 | 0.930 | 0.577 | 8% | 0.983 | 97 |
| v2 | Sonnet | 100 | 0.92 | 0.94 | 5% | 0.99 | 18 |
| v2 + revision | Sonnet | 100 | 0.95 | 0.95 | 7% | 0.98 | 13 |
| v1 (published) | Sonnet | 150 | 0.953 | 0.907 | — | 1.00 | 15 |

The Haiku critic is too noisy to grade decoys: in my hand reading, two of three of its decoy disputes were its own
error. Sonnet agrees far more.

**Hand audit.** I read every Sonnet dispute, and random tasks Sonnet passed. The reviewer's fixes (pair-group visibility for silent changes, `--days` worlds keeping synth background items) apply to v2 and later:

| Run | Disputes that were real errors | Hidden errors among tasks Sonnet passed |
| --- | --- | --- |
| v2 | 11 of 18 | — |
| v2 + revision | 6.5 of 13 | — |
| v1 | 9 of 15 (6.0% of 150) | 2 of 20 read (8 on v2 + revision, 12 on v1) |

The errors fall into a few kinds:

- a decoy that still constrains, for example an older ceiling the request exceeds, a "pending" status, or "Sam
  still carries an EpiPen";
- a decoy or neutral that shows the thing already done, for example a booking confirmation or a payment receipt;
- a fact that does not bear on the request: a summons for another week, a closure before the event, an accepting
  policy;
- a background item or another task's fact that bears on the request: twice in 300 hand-read probes;
- the writer reasoning aloud in the detail ("… wait, correction"). 1.1% of tasks show this, and they are dropped
  from v2 on.

**Error rate.** About 6% of tasks have a confirmed error plus about 10% of the rest hidden, which comes to
**~15% of tasks with at least one wrong label [EST, wide interval: the hidden share rests on 20 hand-read tasks]**.
Facts are wrong in about 2% (3 of 150). Since a task contributes four labelled own items per request, the share of
wrong labels among a task's own items is about 4% **[EST]**. Unrelated labels are almost all right: 1.00 and 0.97
agreement on other tasks' facts and background.

**Other observations.**

- The lexical leak check (a number, reference or name only the fact holds, appearing in a request) was dropped as a
  filter: in the pilot most of its flags were amounts and names the user states themself. It now only flags (5,286
  flags kept in v1). Sonnet said a request gave the fact away in 1 of 150 tasks.
- Realism: Sonnet 3.85 of 5 on v1 (26 at 3, 121 at 4, 3 at 5); Haiku 3.94 on the pilot.
- **Neutral items are weak positives:** Sonnet calls about a third of them unrelated. They are labelled `clear`
  because they were written as same-topic and all clear; a retriever should treat them as soft.

## 5. Running it in the lab (D884)

`synth-sample` (4 committed validation worlds), `synth-train|val|test`, `synth:<file>` and `synth` (train + val)
register as suites. Seed `s` plants world `s mod N` into the base world:

- background and neutral items overwrite base noise items in place, so the planted items stay last, one a task, as
  the harnesses read them;
- the persona is renamed to the base user;
- rare sources get drive's connector profile;
- `@K` plants K worlds a seed, for `--days` users.

Smoke runs:

- `bun run funnel --suite synth-sample --seeds 41,42`: hidden 11/14, decoys 12/14 surfaced (no model, reader stub,
  no cached cards for generated items);
- `days-calls --suite synth-sample@4 --seeds 41 --days 1` ran.

pi-ab reads suites through the same registry.

## 6. Cost

Ledger by role, Anthropic only:

| Role | Spend |
| --- | --- |
| families | $0.50 |
| worlds | $6.95 |
| tasks | $14.31 |
| revision | $4.46 |
| Haiku critic | $0.39 |
| Sonnet audit | $1.78 |

That was $28.40 at the v1 audit. The final ledger is **$35.10**: families $0.50, worlds $7.20, tasks $18.57,
revision $6.66, critics $2.17, over 52,319 calls. Generation costs $0.0109 a valid world (v2's assembly, revision
included). Modal: three short CPU validation runs and volume storage, a few cents **[EST]**.

## 7. What it does not do

- The labels are as good as the writer's construction. About one task in seven has a label a careful reader would
  change, mostly a decoy or neutral that still bears on the request. A model trained on it learns that noise too.
- Similarity is lexical, so a paraphrase of a train template can pass.
- Late and multi-day facts are planted up front in the lab suites. Their timing lives in the dataset's `visible`
  flag, not in the funnel.
- The worlds are English-first. The 8 other languages appear only in requests (about 8% of them), never in items.
