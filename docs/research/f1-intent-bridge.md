# F1: the intent bridge — matching requests that do not share the anticipated words

Status: 2026-11-12, open. Trial `requestGloss` built and screened at $0; its pre-registered Pi pair (§4) is **not
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

**Licence, before shipping.** The word lists' content is CC-BY-SA-4.0 (the repository's code is MIT). The glossary
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
of the 71 changed tasks a variant is a non-English request (Catalan is read through Spanish and French).

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

