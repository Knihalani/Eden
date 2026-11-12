# F4: heldout20, the blind suite for the F1–F3 fixes

2026-11-12. Lab only: no engine change. Decision D1080. heldout20 is the one fresh test of tonight's fixes: F1
(retrieval by meaning and across languages), F2 (the push check's recall) and F3 (packets that say why an item
matters). heldout19 was read once by B19 (D1048) and diagnosed by h19-diagnosis.md, so it can no longer test them.
Every number below comes from a command run in this session. No model, funnel or eval was run on the suite.

## 1. How it was made (as heldout19, D870)

An isolated general-purpose subagent wrote the 48 templates. It was allowed to read only these files:

- a format scaffold: `hidden-heldout20.ts` with heldout19's helpers, interfaces and planting function, and no
  template, invented or copied;
- the HiddenTask interface (lines 1–30 of `hidden-context.ts`);
- the sim world API (`world.ts`, `names.ts`, `text.ts`, `rng.ts`, `rare-sources.ts`);
- a self-check script (counts and structure only), deleted before the commit;
- F4's brief: areas, variants, proportions, the label format and the world time.

It reported one slip. Early on, a `grep -n heldout20` over `suites.ts` showed it four lines of F4's wiring (an
import and the registration), with no suite content. It opened no other file, and it saw no tuning suite (F8's
dev20a–d are on another branch). F4 has not read the templates: only their counts, from the author's report and
the tests.

## 2. What it holds (counts only)

From the author's self-check (seeds 41–52) and its label comments:

- **Areas:** 48 templates, six in each of work, family, health, money, travel, home, admin and social. Each has
  `hidden`, `control` (a look-alike) and `neutral` variants.
- **Phrasing:**
  - 19 indirect plans or statements (`HELDOUT20_INDIRECT`);
  - 12 questions (`HELDOUT20_QUESTION`);
  - 17 imperatives.
- **Languages:** 12 requests are not in English, one each in Swedish, Polish, Turkish, Japanese (romaji), Indonesian,
  Arabic (Arabizi), Romanian, Tagalog, Vietnamese, Greek (Latin script), Czech and Spanish (`HELDOUT20_NON_ENGLISH`).
  Nine of these languages are not in heldout19.
- **Word overlap between request and fact:**
  - none in 29 (`HELDOUT20_NO_OVERLAP`, 60%);
  - a name or reference only in 13;
  - one topic word in 6.
- **Decoys:** 16 resolved or superseded (a), 16 another entity or date (b), 16 condition met (c).
- **Anchored requests:** 16 (`HELDOUT20_ANCHORED`).
- **Rare-connector facts:** 14 (`HELDOUT20_RARE`): school 2, whatsapp 2, health 2, notes 2, bank 2, tasks 2, trips 1,
  residents 1.
- **Silent edits:** 12 (`HELDOUT20_SILENT`, each with its `before` copy from `heldout20Before`): calendar 4, drive 3,
  crm 1, notes 1, trips 1, residents 1, tasks 1.
- **Planted sources (hidden):** gmail 22, calendar 4, drive 4, slack 3, crm 1, and the 14 rare.

Each template's comment labels its overlap, decoy kind, phrasing, source, and whether it is anchored, silent, rare
or non-English, as heldout19's do. Later analysis can split by any of them.

## 3. Its own present

The world time is **Thursday 19 November 2026, 17:30 UTC** (`HELDOUT20_NOW`), not the base world's Tuesday
27 October, 09:00.

- `prepareWorld("heldout20")` moves `world.now` there before it adds the rare connectors, whose filler is dated
  from it.
- Every harness reads `world.now`: the clock, the agent's "today" and the calendar-slot clearing.
- Planting refuses a world that was not moved.

The base world's ~1,500 items keep their dates. They read as history at least 23 days old, and calendar events
between 27 October and 19 November are now in the past. That is a known bias: the planted items are the only ones
from the last three weeks, so recency favours them a little more than in heldout19.

A `--days` user planned over heldout20 together with another suite is refused (`userWorldOf`), because one of the
two would read the wrong today. On its own, a heldout20 user builds: 40 requests over two days of 20, on the moved
clock (seeds 41 and 44, checked).

## 4. Registration

- `UNRUN_BLIND` and `UNREAD_BLIND` (now `["heldout20"]`: heldout19 was read by B19, D1048).
- `NEUTRAL_SUITES` and `needsPrepared`.
- Out of `all`.
- `suites.test.ts` checks the format only: counts, ids, refs, the lists against each other and the sources, the
  silent edits' `before`, the clock, and the mixed-user refusal.

## 5. Shipped coverage: not recorded (blocked)

The recording that D872 made for heldout19 (`cold-start.ts --cards-out`, Haiku 5.5 through the lab transport, seeds
41–44, every variant plus the days users) was started and stopped on its first world. Every card call returned
HTTP 400: the Anthropic account's credit balance is too low. The run made 70 calls and spent $0, and nothing was
written.

So heldout20 is not in `cards-shipped.jsonl.gz` or `SHIPPED_COVERS`. A harness at the default coverage falls back to
full coverage for it, with no replayed cards (made live in-run).

`packages/sim/lab/f4/record-coverage.sh` runs the recording once credit is back, for about $0.2. It refuses to keep
a run in which any world made no card call. Its output goes to the final runner's replay (B19's `--coverage full
--cards F --intent F`), or into the shipped file with heldout20 added to `SHIPPED_FORM_COVERS`. It should run on the
tree whose default the final read measures, since a changed card form keys its lines apart.

## 6. Use

Measurement only, once: the parent's final read of F1–F3. Never tune on it. Nobody runs a funnel, eval or agent on
it before that read.
