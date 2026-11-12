# F1: the intent bridge — matching requests that do not share the anticipated words

Status: 2026-11-12, open. §7 (the glossary rebuilt without outside lists) and §8 (an encoder feeding the push check,
a subagent-simulated pilot that failed its rule) are the latest. Trial `requestGloss` built and screened at $0; its pre-registered Pi pair (§4) is **not
run**: the Anthropic account ran out of credit during this session (every call returns "credit balance is too low").
Tuning and selection used only train1–6, reworded (train1r–6r) and longtail, seeds 41–44, at shipped coverage.
heldout19 was not read; heldout20 was not looked for.

The brief (h19-diagnosis.md §1): on heldout19 31% of hidden facts never reached the agent, and none of those 50
matched the user's request in the intent index although 42 were carded. The levers: a multilingual encoder over the
short anticipated requests, more phrasings from the card call, request-side normalisation, better scoring.

Every screen below runs from three $0 dumps of the shipped default:

- `bun run funnel --suite S --seeds 41,42,43,44 -- --pool-dump --ask-diag --corpus-dump --neutral --ask` for S in
  train, reworded and longtail;
- `bun packages/sim/src/lab/m11-export.ts --suites train,reworded,longtail --seeds 41-44` (items, worlds, planted keys).

The planted item in **the check's view** means in the push pool's first 15, which the push check reads
(`pushCheckItems`); **handed** means in the first five.

## 1. Where the proxies lose facts (hidden, seeds 41–44)

| suite | facts in the check's view | not handed: requests, no intent hit | not handed: no requests | look-alikes in view |
| --- | ---: | ---: | ---: | ---: |
| train | 652 / 768 (85%) | 24 | 99 | 575 |
| reworded | 598 / 768 (78%) | 49 | 111 | 523 |
| longtail | 61 / 96 (64%) | 0 | 25 | 52 |

On the proxies BM25 over the anticipated requests already reaches most planted items that have requests: an offline
replica of the engine's cut (`keepIntents`) reaches 529 of 606 such items on train, 435 of 506 on reworded English and
69 of 100 on reworded non-English. The proxies' misses are mostly items with no requests (the shipped enricher's lean
read skips them) and, on reworded, non-English requests. Reworded against train, template by template: English
templates lose 21 facts from the view, non-English ones 33 (of 144). By word overlap with the fact (stemmed content
words): no overlap 61/116 in view on train, 60/149 on reworded, 0/24 on longtail.

So the train-side proxies are much easier for the intent bridge than heldout19 was: their wording keeps the names and
details the card call's requests also use. A lever aimed at heldout19's "no word overlap" class has little to show
here, and the one class the proxies do share with heldout19 is the non-English one.

## 2. Lever (a): a multilingual sentence encoder over the anticipated requests — not built

Screen (`.local/f1/gain.py`, offline, int8 ONNX models on CPU through onnxruntime, mean pooling, e5 with its
`query:` prefix): each request against every item's requests (max cosine), the encoder's top k with cosine ≥ τ added
to the check's view. Counted only where the planted item was not already in view. train + reworded, 1,536 tasks a
variant:

| encoder (size int8) | k, τ | facts added | look-alikes added | neutral items added a task |
| --- | --- | ---: | ---: | ---: |
| multilingual-e5-small (118 MB) | 1, 0.84 | 26 (5 non-English) | 43 | 0.97 |
| multilingual-e5-small | 3, 0.86 | 16 | 34 | 0.47 |
| multilingual-e5-base (279 MB) | 1, 0.80 | 41 (8) | 48 | 1.20 |
| multilingual-e5-base | 1, 0.82 | 26 | 41 | 0.57 |
| multilingual-e5-large (562 MB) | 1, 0.82 | 35 (9) | 42 | 0.57 |
| multilingual-e5-large | 3, 0.80 | 62 (11) | 67 | 3.17 |

paraphrase-multilingual-MiniLM-L12-v2 reached almost nothing at these cosines (its scale is lower; not swept
further). At every setting the encoder adds look-alikes faster than facts (the look-alike's card anticipates the same
requests) and adds about one neutral item a task, for a 118–562 MB model in every process and a new runtime
dependency. This is D450–D452's finding again, on the anticipated requests instead of item text: **not built**.

## 3. Lever (c): the request glossary (`requestGloss`, trial, off)

**What.** `gloss.ts`: a request written in another language is given the English words its own words mean, with no
model and no call, and the push's and an ask's lookup search with them (ahead of the request's own words, so the cue's
16-term cap keeps them) both lexically and in the intent index. The request text itself (`cue.raw`: the push check's
request, plan quotes, imperative tests) is left as written. English requests are not touched (`glossOf` returns "").

**The glossary** (`gloss.bin`, 0.92 MB, gzip of JSON): 12 Latin-script languages (es, fr, de, it, pt, nl, pl, sv, da,
no, ro, tr), each the first 20,000 alphabetic words of a frequency list (hermitdave/FrequencyWords, OpenSubtitles
2018) glossed by Haiku 5.5 into up to three English base words, nothing for function words and names
(`packages/sim/src/lab/gloss-make.ts`, $0.94 on the spend ledger; 39 of 600 batches, about 15,600 words, failed when
the account's credit ran out and are missing). `gloss-pack.ts` keeps 179,363 glossed words and, per language, its
function words (the first 300 words whose gloss is empty or English stopwords, less the first 2,000 English words),
which tell the language: a request is read as language L when it holds at least two of L's function words that are
not English stopwords (ties keep both). German, Dutch and the Scandinavian languages split an unknown compound into two
known words. Hindi in Latin script is not covered (no frequency list).

**Licence: being replaced (the integrator's call, 2026-11-12: do not ship CC-BY-SA content).** `gloss-make.ts` now
writes the vocabulary itself: per language, one Haiku call per everyday topic (38 topics fixed in the script, life
areas rather than suites) for the words a native speaker uses with their English, and one for the function words; no
outside list. 26 languages (the 12 above plus ca, fi, hu, cs, id, ms, tl, sw, vi, ru, el, ar, ko and Hinglish), at
most $6.11 by its reservation. It waits for Anthropic credit; the Pi pair waits for it, and the screens above are
re-run on the rebuilt glossary first (a material change is noted here, the rule stays as committed). Until then the
committed `gloss.bin` is the frequency-list build and must not merge. The original note: The word lists' content is CC-BY-SA-4.0 (the repository's code is MIT). The glossary
holds those words as its keys, with Haiku's glosses. Whether that needs attribution or share-alike is the owner's
call; the glossary can be rebuilt from another word list (or a model-written one) with `gloss-make.ts` for about $1.

**After the review (REQUEST_CHANGES, fixed):** an English request about foreign names ("Pay the van der Berg invoice
… Pieter van den Heuvel", "Ask Giuseppe di Napoli about la dolce vita catering") was glossed by the first rule (two
function words of a language). The language is now told from the request's words outside names (a capitalised word
past the first, and the word just before one, are left out) and must hold more words known to that language than
words known to English (the glosses' own English words and the stopwords); `gloss.test.ts` holds the review's probes.
The gloss is capped at 12 words (24 before) so a long request keeps cue room, input is NFC-normalised, a glossary that
parses but reads wrong is refused at load, `glossOf` never throws, and the partner reads the glossary when it is built
with the switch on. Reworded with these: hidden 581, decoys 523 (527 before), the same facts in view (+22 −2); train
and longtail still identical.

**dev20 (D1100; coverage none, so intent-inert: the lexical half only), seeds 41–44:** hidden surfaced 155 → 180 of
640, decoys 125 → 147; facts in the check's view 157 → 181, handed 114 → 136; look-alikes in view 125 → 149. Every one
of the 71 changed tasks a variant is a non-English request (Catalan is read through Spanish and French). By the suites' own labels (facts in view, default → gloss, seed × template): non-English 16 → 40 of 160, no word
overlap 12 → 36, indirect 79 → 95, questions 31 → 43, world knowledge 18 → 22, rare sources 44 → 44, silent edits
38 → 42. Intent-inert, so these are the lexical half only; dev20's cards wait for credit (credit.sh).

**Cost.** No model call at request time. The glossary loads once a process, at the first glossed request: 29 ms,
+9.1 MB RSS (+6.0 MB heap; measured before the review's English-word set, which adds about 1 MB), +11.1 MB after six languages are read (a binary search over each language's sorted lines;
a Map per language cost +26 MB). 3.4 µs for an English request, 9.6 µs for a glossed one.

**Funnel, reworded, seeds 41–44 (stub reader, shipped coverage):**

| | default | `requestGloss` |
| --- | ---: | ---: |
| hidden surfaced | 555 / 768 | 581 / 768 |
| decoys surfaced | 499 / 768 | 527 / 768 |
| non-English facts in the check's view | 80 / 144 | 100 / 144 (+22 −2) |
| non-English facts handed | 70 / 144 | 92 / 144 (+22 −0) |
| non-English look-alikes in view | 77 / 144 | 105 / 144 (+31 −3) |
| neutral tasks with a packet (no check wired) | 705 / 768 | 731 / 768 |
| English tasks (624 a variant) | | identical, task by task |

train and longtail are identical task by task (hidden 597/541 and 64/50 both). The ceiling, the same non-English
templates in their English train wording, is 113 facts in view: the glossary closes 20 of its 33. By language, facts in
view (English wording / as written / glossed): de 18/14/18, es 17/14/13, fr 16/8/12, it 12/12/12, nl 12/4/8, pl
12/8/12, pt 14/9/14, hi 12/11/11.

Look-alikes rise with the facts, as for every bridge (they anticipate the same requests); the push check and the
agent are the guard (h19-diagnosis.md §2: one concern from 29 look-alikes handed). In the funnel the neutral line has
no check wired, so it overstates packets: the live pair measures them.

`bun run eval` is unchanged with the switch off (it is off in the default).

## 4. The pre-registered Pi pair (not run: no Anthropic credit)

Committed before any paid run, in the commit that adds the switch:

- Suite `reworded`, the 36 non-English templates (the only tasks the switch can change: English requests get no
  gloss), seeds 41–48 (41–44 at shipped coverage, 45–48 with cards made in-run by Haiku, shared by both arms), variants
  hidden, control and neutral.
- Arms `both+ask` (the default) and `both~gloss+ask` (`requestGloss` on), one process a seed; Haiku 5.5 agent, cards,
  reader and check; Sonnet 5.5 grader; `--tenant-prompt`, `--push payload`, the direct market profile.
- **Promote** if hidden raised rises with the template-clustered 95% lower bound above 0 points, confirmed concerns
  (control and neutral, Sonnet) do not rise, and neutral tasks given a packet rise by no more than 2 points; else
  delete the switch, `gloss.ts`, `gloss.bin` and their tests, keeping this note.

## 5. What else was looked at

- **Lever (b), more phrasings from the card call.** Not run: it needs a re-enrichment of every replay cache (about
  $0.6 for train, reworded and longtail), and the proxies' intent hits are near their ceiling (§1). D331(2) (up to 8
  requests: 290/280 against 305/267) and D201 (agent-worded requests) already lost facts on the funnel.
- **Lever (d), scoring.** The carded intent hits that are kept but not handed (reworded: 79 facts, 50 look-alikes) are
  the ranking's to win; D266 and D330 put more such items in the packet and raised no more facts live.
- **The whole message beside the push's request (`pushContext`, built and deleted at $0).** When `pushStart` reads the
  request from part of a message ("I need Mum to collect Theo from nursery…, can you message her?" is pushed as "can
  you message her?"), the lookup also searched with the whole message. On reworded 56 hidden requests lose two or more
  content words this way (41 of them in the check's view, against 505 of 648 for the rest), but the switch moved
  reworded's facts in view +4 −0 and handed +0 −2 (surfaced 555 → 554), train nothing: not opened as a trial. Two of
  the English facts rewording loses are pushes that never start ("I want a morning flight…": `pushStart` is null), the
  push gate's matter rather than retrieval's.

## 6. Lever (b) built: `cardsRequestsWide` (rejected and deleted, D1154, §13)

The card prompt's form 4 (`CARD_FORM_WIDE`): form 3 with one sentence added to the intent instructions, asking for the
same four requests in the forms users word one intent in: a plain request, a plan or need ("I want to …", "thinking of
…"), the broad kind of action the item bears on in general words (a flight's new time: "book any flight, train or taxi
that day"), and a question. Its replies are their own replay form (`:f4`), so a run asks and replays them apart from
form 3's. `cards-requests-wide.test.ts` pins that nothing else in the prompt changes. D331(2) (eight requests) and D201
(agent-worded requests) lost facts; this keeps the count at four and changes only their spread.

It cannot be screened at $0: every replay file holds forms 0 and 3 only. The pre-registered rule is the trials row in
DECISIONS: re-made cards for dev20 and reworded (seeds 41–44) in form 4 against form 3, a $0 bar (hidden facts in the
check's view +28 of 1,408 or more, card output tokens an item +15% or less) before a Pi pair, and the same Pi rule as
`requestGloss`.

The test and the trials row were deleted with the switch (D1154). The rule applied is 89d98a27's re-registration, which
measured the requests' characters an item in place of card output tokens (§13).

## 7. The glossary rebuilt from the model's own vocabulary (no outside list)

The integrator ruled out shipping CC-BY-SA content. With no API credit, Haiku subagents (one or more a language, the
Agent tool, no API spend) wrote each language's vocabulary themselves: function words, then about 60–100 words for
each of the 38 everyday topics in `gloss-make.ts`, each with up to three English words. 26 languages, 118,663 lines
written; `gloss-pack.ts` (now skipping malformed lines) keeps single words, lowercases, merges duplicates and drops a
word glossed as itself: 86,441 words, `gloss.bin` 0.58 MB. Known weak spots: European Portuguese ("canalizador" is
missing, "encanador" is there), Vietnamese (806 syllables), Hindi in Latin letters (1,165).

Screens with it (funnel, seeds 41–44, `--set '{"requestGloss":true}'`; the old frequency-list build in brackets):

| suite | hidden | decoys | |
| --- | --- | --- | --- |
| reworded | 555 → 575 (581) | 499 → 511 (523) | non-English facts in view 80 → 100 of 144, handed 70 → 88 |
| dev20 (intent-inert) | 155 → 179 (180) | 125 → 153 (147) | facts in view 157 → 178, handed 114 → 138 |
| train, longtail | identical | identical | |

Every changed dev20 task is a non-English one (0 English tasks changed of 640 a variant; 240 non-English rows). The
review's English-with-foreign-names probes still pass. Language detection now counts function words first and
searches the lexicons only for a language with one of them in the request: 12.5 µs for an English request, 22.6 µs
for a German one (226 µs before the change). The glossary loads at partner construction: 118 ms, +29 MB RSS once a
process.

## 8. The encoder feeding the push check: a subagent-simulated pilot (failed its rule; not built)

The owner's direction: matching by words breaks in production, so test meaning. The encoder's candidates go not to
the agent but to the push check's pool, where Haiku's knowledge can drop the look-alikes.

**$0 screen (item text).** multilingual-e5-small (int8 ONNX) over each item's title and head (`passage:`) against the
request (`query:`), its top k items not already in the pool's first 15:

| suite | k | facts newly in the check's view | look-alikes |
| --- | --- | --- | --- |
| dev20 (157 of 640 in view) | 5 | +37 | +26 |
| dev20 | 10 | +58 | +30 |
| train + reworded (1,250 of 1,536) | 5 | +54 | +56 |

**Cost (measured, Python onnxruntime, one thread).** A request 5.2 ms (30 tokens); an item 15.3 ms (89 tokens), so a
1,500-item user's backfill is about 23 s of CPU; the model session +143 MB and the Hugging Face tokenizer's 250k-word
vocabulary +295 MB RSS a process. A TypeScript port would need onnxruntime-node (a new dependency) or a pure-TS int8
forward.

**Pilot (rule pre-registered in 1fdb625f before any answer was read).** dev20 seeds 41–44, the check's exact prompts
(`checkMessages`, `readerItem`, the default's 200 characters an item) over the pool's first 15 plus the encoder's top
5 not in it (20 items, the check's `CHECK_MAX_ITEMS`); every hidden and control task where the encoder added the
planted item, and 143 neutral tasks with and without the extras (`f1-check-pilot.ts`). 354 prompts were answered by 15
Haiku subagents (25 each, shuffled; base and extended answers of one task usually by different subagents). Label:
**subagent-simulated**.

| | result | bar | |
| --- | --- | --- | --- |
| hidden: the check names the added fact | 42 of 42 | ≥ 50% | pass |
| control: the check names the added look-alike | 4 of 26 (15%) | ≤ 25% | pass |
| neutral: any item named | 11 → 20 of 143 (+6.3 points; 11 up, 2 down) | ≤ +3 | **fail** |

So no engine trial is built (the rule). What the neutral rise is: in 6 of the 11 the check named an encoder extra (for
example "Coffee with Fatima, Thursday 09:30" against a request about being out all Thursday: a real clash in the
neutral world, not a look-alike); the other 5 named items of the shared 15, so subagent-to-subagent variance is part
of it. The facts side is strong: the check took every added fact and dropped 85% of the added look-alikes. A
narrower variant (fewer extras, or a cosine floor) would need its own pre-registered rule and its own answers; the
neutral measure needs repeated answers of the same prompt to separate the variance.


## 9. The narrow encoder variant in the push check (F1 alone; F2's arm withdrawn)

**Design.** As the integrator asked after D1150: at most 3 encoder items (multilingual-e5-small over each item's title
and head), each with cosine ≥ 0.84, appended to the check's view only when they are not already in it. k 3 and the
0.84 floor were chosen on train and reworded only (the most facts added with at most 0.5 neutral extras a task). The
pilot was first planned with F2 as three arms (cab88c8e). F2 then withdrew its Q3 views because of a bug: picks filled
the first places on short pools. So the encoder arm was re-registered alone (2009f3b7): B' = the engine's own first
15 plus the extras. Its rule is cab88c8e's as written. The task set is dev20 seeds 41–44, coverage none. Hidden and
control tasks where B' adds the planted item were asked once. On 60 neutral tasks where B' differs from base, each
distinct prompt was asked 3 times and the majority read. 373 of 374 prompts were answered: 325 by 13 Haiku subagents,
49 reused from identical prompts of the withdrawn run. The one prompt not answered is a base prompt with no items.
**Label: subagent-simulated (D1101).**

| | result | bar | |
| --- | --- | --- | --- |
| hidden: the check names the added fact | 9 of 9 | ≥ 50% | pass |
| control: the check names the added look-alike | 0 of 5 | ≤ 25% | pass |
| neutral: any item named (majority of 3) | 10 → 12 of 60 (+3.3 points; 3 up, 1 down) | ≤ +3 | **fail** |

The variant fails the rule by one task. Why the neutral tasks fire:

- Both B'-only fires are one template, `early-standup-phased-return`, on seeds 42 and 44. The request is "move our
  daily standup to 8:15". The base pool was empty, and the encoder added real messages from the world: "standup moved
  to 10:15". That is arguably context worth giving, not a look-alike.
- The third task up (a boiler timer) and the one task down (an invoice) named items both arms share. That is the
  subagents' own variance.

**Why it is not worth fixing with a floor.**

- Every added fact, look-alike and standup message scores between 0.841 and 0.852. No floor separates them.
- The gain is narrow: 8 of the 9 facts come where the lexical pool was empty, and all 9 are in four dev20c templates
  (parents-parking, upvc-windows, jamie-cabin-share, friday-dinner-cancel). That is +9 facts in the check's reply of
  640 hidden tasks, about +1.4 points.

**Cost, quality, speed.**

- Quality: +9 of 640 dev20 hidden facts named (subagent-simulated), 0 look-alikes added, neutral +3.3 points.
- Cost: about 45 of 640 tasks a variant gain a check call they did not make (an empty pool now holds extras), about
  +7% check calls. About 27% of check prompts carry about 2.3 extra items, roughly +460 characters each (estimate from
  the extras file, not deduplicated against the view).
- Speed: 4–5 ms a request on one thread (F2's onnxruntime-node figure; 5.2 ms in Python). Items are encoded in the
  background at 15–25 ms each. RSS +131–155 MB for the model and +56 MB for F2's TypeScript tokenizer.

**Verdict: not built (the rule).** It is the third measurement of the encoder in the check (D1150, this one, and the
withdrawn three-arm run, where B over F2's pool also failed). The fact side is strong every time: the check takes
almost every added fact and drops almost every added look-alike. The gain where facts are missing from the view is
small and concentrated, and its price is a model in every process plus new check calls.

## 10. The request glossary through the queue (rule 67a019b6)

reworded's 36 non-English templates, seeds 41–44, the shipped default against `requestGloss`. The push check was
answered through `EDEN_LAB_QUEUE` by Haiku subagents (D1101), with identical prompts answered once for both arms.
`bun run funnel ... -- --check live --neutral --ask`, scored by `packages/sim/lab/f1/gloss_score.py`. The first
complete run (09:12 UTC) finished while about 40 checks were still in the queue. Those checks failed open, which made
many neutral tasks deliver in both arms. Both arms were run again once the queue was empty, with 336 of 337 and 377 of
381 checks replayed and 0 missed. Those numbers are the result. **Label: served by subagents (D1101).**

| | base | gloss | |
| --- | --- | --- | --- |
| hidden delivered (144) | 80 | 100 (22 up, 2 down; +13.9 points, template-clustered 95% [+2.8, +26.4]) | pass |
| look-alike delivered (144) | 35 | 35 (1 up, 1 down) | pass |
| neutral tasks with any delivery (144) | 17 | 26 (+6.2 points) | **fail** (≤ +2) |
| check calls | 337 | 381 (+13%) | |

The gloss is a pure CPU step: 12.5 µs on an English request, 22.6 µs on a German one, +29 MB RSS, 118 ms to load
once. The cost it adds is the extra check calls (+13%) on non-English requests.

**Why the neutral tasks fire (read from the pool dumps).** Of the 11 neutral tasks the gloss arm newly hands items
to, 6 hand the "Expense policy" reminder ("travel over £500 needs approval") to a request to book flights. Others hand
existing travel bookings to a request about a call next week. One hands lunch plans to an order for a team lunch.
These are the same items an English request about the same thing reaches. Once a Spanish, Portuguese or Hinglish
request is glossed, Eden behaves on it as it does on English; the base arm's low neutral rate on non-English requests
(17 of 144) comes from not reading them. The rule as written counts that parity as harm. A fair bar compares a
glossed request's neutral rate with its English twin's, but that is a new rule and needs its own run.

**Verdict by the rule: fails on neutral.** The switch stays off. The decision, kept as a no-model fallback with an
English-parity rule or deleted, is for the integrator.

## 11. Re-screens on the world-clock shipped coverage (D1102)

After main's re-recorded coverage (3de40f4a), both encoder sides were screened again at $0.

- **The item encoder in the push check (§9).** dev20 seeds 41–44 at shipped coverage (main's baseline reproduced:
  292/216 of 640). The check's view (the pool's first 15) plus at most 3 e5-small items at cosine ≥ 0.84 adds the
  planted fact in 9 hidden tasks and the look-alike in 5 control tasks, and changes 149 neutral tasks: the same
  counts as the pilot's, with 9 of its 10 hidden and control prompts identical. D1151 stands.
- **The request encoder over the anticipated requests (§2), on the new requests.** e5-small with its `query:`
  prefix, each request against every item's shipped requests (max cosine), top k at cosine ≥ τ, counted only where
  the planted item was not already in the check's view (pool dumps at shipped coverage, seeds 41–44; train 645/597,
  reworded 608/576, longtail 71/60):

| tasks | k, τ | facts added | look-alikes added | neutral items a task |
| --- | --- | ---: | ---: | ---: |
| train (768) | 1, 0.84 | 16 | 15 | 0.6 |
| train | 3, 0.84 | 19 | 23 | 1.3 |
| reworded, English (624) | 3, 0.84 | 15 | 20 | 1.9 |
| reworded, non-English (144) | 1, 0.84 | 9 | 16 | 0.6 |
| reworded, non-English | 3, 0.84 | 14 | 21 | 1.4 |
| longtail (96) | 3, 0.84 | 4 | 4 | 2.7 |

  On the new coverage the request side still adds look-alikes as fast as facts or faster. This is §2's finding
  again, so it is not built.

## 12. The glossary against English twins, on the world-clock coverage: promoted (D1153)

**The rule.** The integrator agreed that D1152's bar counted parity with English as harm, so the rule was
re-registered before any run (cfc0656d). It was amended in b5b6b58b, still before any run, so that all three arms run
on main's world-clock coverage (D1102). The rule: promote iff hidden delivered with the gloss has a template-clustered
95% lower bound above 0, look-alikes rise no more than facts, and the glossed neutral rate is at most the English
originals' plus 2 points.

**The run.** `bun run funnel ... -- --templates <reworded's 36 non-English> --check live --neutral --ask`, seeds 41–44,
three arms: reworded with the default, reworded with `requestGloss`, and train1–6 on the same templates (the English
originals). The push check was served by subagents (D1101) through one queue; every check was answered (0 misses).
The first live-queue run is not used: the subagents' answers came after the push stopped waiting for its check
(p50 95–108 s against `pushCheckWaitMs` 1,500 ms), so that run's packets went out unchecked (gloss: hidden 105,
control 103, neutral 127; English: 113, 121, 138), and its base arm exited with an error. The numbers below are the
replayed runs, whose checks land within the wait: every arm re-run with the answers replayed, and the glossed and
English arms a third time on fresh caches (answers read from the queue's store), with identical numbers between the
second and third runs.

| | reworded, default | reworded, `requestGloss` | English originals |
| --- | ---: | ---: | ---: |
| hidden delivered (144) | 88 | **112** (24 up, 0 down) | 119 |
| look-alikes delivered (144) | 45 | 49 (10 up, 6 down) | 76 |
| neutral tasks with any delivery (144) | 50 | **21** | 53 |
| push check calls | 343 | 389 | 418 |

Hidden +16.7 points, template-clustered 95% [+6.2, +28.5]; look-alikes +4 against facts +24; neutral 21 against a bar
of 55. **Pass: promoted into the default (D1153).**

Why the neutral rate falls: without the gloss, a non-English request's pool holds only what its names match, and the
check passes some of those by name alone. In 39 neutral tasks the default handed an item that the glossed arm did
not, for example "Payment sent: Aperture Labs" against a Polish request to escalate a support case with Aperture
Labs. With the gloss, the pool and the check read what the request means. D1152's neutral rise (17 → 26) was measured
on the pre-D1102 coverage.

**Cost, quality, speed.** Quality is above. Cost: +13% push check calls, on non-English requests only (389, still
below the English originals' 418), and none on English as measured: 0 of 468 distinct English requests in train1–6,
dev6a/b, the hidden suites and longtail are glossed, and `bun run eval` is identical (precision 0.65, recall 0.52,
falseFireRate 0; acting 19 of 28 neutral, facts 10 of 11, look-alikes 3 of 10). Speed: 12.5 µs an English request,
22.6 µs a German one. Memory: +29 MB RSS and 118 ms to load once a process, when the partner is built.

## 13. `cardsRequestsWide` screened on the world-clock coverage: rejected and deleted (D1154)

Form-4 cards (§6) were recorded with `cold-start.ts --clock world --set '{"cardsRequestsWide":true}'` through the
queue (served by subagents, D1101) for dev20 seeds 41–44, every variant. They were compared with F8's shipped form 3
(D1102), both replayed through the same `bun run funnel --cards F --intent F` path (the shipped file, and the shipped
file plus the form-4 lines), with pool dumps:

| dev20, 640 tasks a variant | form 3 (shipped) | form 4 |
| --- | ---: | ---: |
| hidden facts in the check's view | 314 | 283 (21 up, 52 down) |
| look-alikes in view | 256 | 239 |
| delivered with the stub reader, hidden / decoys | 345 / 259 | 325 / 251 |
| the requests' characters an item | 87.7 | 123.8 (+41%) |

The rule (606571ee, re-registered in 89d98a27) needed +28 facts in view over dev20 and reworded's 1,408 hidden tasks
with request characters up at most 15%. dev20 alone is −31 and +41%, so reworded was not recorded to the end and the
switch is deleted with its code and tests (D814). Varied, more general requests lengthen each item's request text in
the intent index and weaken the specific terms it was met by; the broad-kind request did not reach the requests it was
written for. Caveat: form 3 was answered per item (D1102) and form 4 per call of 20 items (D1101), so the transport
differs; the rule named F8's coverage as the comparator. Two card answers in the queue are known to be faulty (one
with its requests shifted by one item, one with a wrong request), out of about 600 calls.

## 14. "Reached, not raised": a harness drop (D1155), then stale copies

**The drop.** In F6's dev20 rehearsal (seed 41, served by subagents, D1101, single-shot), all 29 hidden facts
"reached, not raised" came through the `ask_context` answer alone. In 18 of them the answer said "[source] Title: (shown
above)" though no packet the agent received held the item. pi-ab's search tools (and hermes-ab's `tool()` hook)
observed the tool result and dropped the injection it returned: the push's packet, still pending because its check came
late, was handed out there (Eden marked its items shown) and never placed. Fixed in #315 (`observe-tool.ts`, D1155).

**Re-measured** (dev20 seed 41, the Eden arm with go.sh's settings, `default`, old harness against the fixed one, one
queue so unchanged prompts replayed; served by subagents, single-shot; 160 tasks a variant):

| | old harness | fixed | |
| --- | ---: | ---: | --- |
| hidden raised | 43 | 77 (34 up, 0 down) | +21.2 points, template-clustered 95% [+15.0, +27.5] |
| control concerns | 1 | 2 | +0.6 [+0.0, +1.9] |
| neutral concerns | 30 | 35 (7 up, 2 down) | +3.1 [−0.6, +6.9] |
| hidden tasks with a packet | 66 | 112 | |

**What is left** (the fixed run's hidden stages: raised 77, reached and not raised 16, dropped by the check 2, never
retrieved 65). The 16 were read against each template's ground truth by hand: 13 are stale copies (the agent was handed
Eden's cached, pre-edit text of the planted item, and answered faithfully from it: a train's old departure, a flight's
old landing time, a balance before an edit, a cut-off before it moved, a task shown open that is done), 2 need world
knowledge (a Lifetime ISA's 25% charge; a 6-month passport rule) and 1 is an uptake miss (a payroll-date message in the
ask answer). None is a cut snippet, an item the check left out or a grader miss, so the packet's order, lead and window
have nothing left to win here.

**`freshenHanded` (built, screened at $0, not run live).** The first N constraint-like items of the push gate's pool
re-read beside the check (branch `claude/f1-freshen-handed`, not merged). At $0 (funnel, dev20 41–44, N 3): the planted
item's line in every handed packet was identical in both arms (215 hidden, 158 control), because the funnel's on-demand
poll already hands current copies, while connector calls rose 3.52 → 5.52 a request (+35% amortised). The stale copies
appear in pi-ab's single-shot streams, where the push's decision landed at 63.7 s with the sync's freshen making no
calls; that case was not measured (the account's subagent capacity ran out), and F3's #313 floor may cover it. Not
handed on.
