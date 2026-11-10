# O1: a source earns its live reads (`sourceYieldEarn`, connector calls at 1,000 sources)

Status: pre-registered 2026-11-10 on branch `claude/o1-calls` (from `claude/lucid-hypatia-v9wqk5` at 3ee07ac6).
Decisions D600–D602. Paid calls: Anthropic API only, the Modal Secret `HAIKU_API_KEY`, `claude-haiku-5-5` in every
role, `claude-sonnet-5-5` for the concern regrade, lab provider (D97): **Anthropic-direct lab figures**, not the
OpenRouter route the servers ship. Train suites only; `heldout18` is not run or read. Sections 0 and 1 were written
and pushed before any paid call.

## In plain words (before the paid run)

- **The problem.** A user with about 1,000 connected sources costs Eden 27 connector calls a task one request a
  session and 12 over their days (N1b, D542). On a per-call connector plan that is the whole bill: Zapier MCP about
  $750 per 1,000 tasks, against $0.56 for every model token of the agent and Eden together.
- **What the calls are.** At $0 (the funnel at 995 noise connectors, seed 41: 33.3 calls a task) 27 of the 33 go to
  noise connectors. `sourceYield`'s pooled rule should stop them and does not within a user's first 32 tasks: a
  pool starts flat and needs about 44 unpaid reads before it acts, and the pool of reads on the request's words
  never closes, because a noise item listed in an ask's answer counts as its source's first use (about three noise
  items reach the agent a task; the words pool sat at 95 reads and 2–4 "wins").
- **The idea.** Turn the default around: **a source earns live reads on weak evidence; it does not start with
  them.** A warm copy none of whose items has ever reached the agent is read live only on strong evidence: a name
  its items mentioned (as today), or a word of the request that at most two of the user's sources hold in their
  vocabulary sketches (new: "Vitalis" is in one source's sketch, "deploy" in hundreds). Once an item of the source
  has reached the agent, it is read as today.
- **At $0** (section 1): calls 33.3 / 31.0 / 33.9 / 34.2 → **8.2 / 8.5 / 8.8 / 9.8** a task on seeds 41–44, hidden
  facts surfaced 306 → 302 of 384: one fewer a seed, the same template each time (a chance delivery, section 1); over
  8 days 12.3 → 6.7 a request with the first day 26.6 → 8.1, surfaced 18 of 23 both.

## 0. Pre-registration

**Trial.** `sourceYieldEarn` (D600; off; `sourceYieldRare` 2). With `sourceYield`: `spentSources` treats both
pooled rates as spent from a user's first request, so a warm copy with nothing used is read live (searched behind,
probed, polled on demand if cut) only when `evidenceFor` says 2; and `evidenceFor` says 2 also for a source whose
sketch holds a request term that at most `sourceYieldRare` of the user's sketched sources hold (`Sync.sketchRare`).
No call is added; no model call; state is the existing per-user `SourceYield` and sketches.

**Harness.** N1b's, unchanged (D540, D543): Pi (`pi-ab.ts`), `--config default`, `--tenant-prompt`, market `direct`
source profile, time scale 1, `--push payload`, `--noise-sources 995 --notify-share 0.05`, `claude-haiku-5-5` as
agent, grader, card model and reader, cards and intent requests replayed on seeds 41–44 and made in-run on the
others. One seed a shard on Modal, `lab_fanout.py --preset bench-earn`, **at most two shards at once**
(`packages/sim/lab/o1/run.sh`). The image is the commit that holds this section.

| arm | settings over the default |
| --- | --- |
| `eden` | none (the shipped default) |
| `eden~earn` | `{"sourceYieldEarn":true}` |

The effect reported is **`eden~earn − eden`**. Negative hidden means the trial loses facts.

**Runs.**

1. Smoke: seed 41, `--limit 2`, cap $0.05. Not in any result.
2. Short, seeds 41–44: `--limit 16 --variants hidden,control`. Cap $1.12.
3. Short, seeds 45–64: `--limit 16 --variants hidden`, 20 shards, cap $3.60 ($0.18 a shard; N1b's spent $0.13).
4. Long, seeds 41–48: `--days 8`, one user a seed, cap $1.60 ($0.20 a shard; N1b's spent $0.11–0.15).
5. Regrade: every control and neutral answer the Haiku grader called a concern, both arms, runs 2 and 4, with
   `claude-sonnet-5-5`; Sonnet's verdict replaces Haiku's. Cap $0.15.

**Metrics** (paired by task; 95% intervals by bootstrap with templates resampled as clusters, `bench_report.py`):
hidden facts raised (Haiku-graded, D456), pooled over runs 2–4 with each horizon beside it; Eden's connector calls
a task, short and long (1:1:8 mix; `a8/pair.py`); $ per 1,000 tasks first-party and on market.py's connector plans
(list prices, assumed); false concerns on control and neutral tasks, Sonnet-regraded; wall mean; asks a task.

**Rule (written before any run; applied mechanically).**

- **Promote `sourceYieldEarn` into `DEFAULT_CONFIG`** (and delete the pooled rule it replaces: `poolSpent`, the
  pools, `sourceYieldFloor`, `sourceYieldWords`) if all hold:
  1. the pooled hidden effect's template-clustered 95% interval has its **lower bound above −2.0 points** (N1b's
     margin, D540);
  2. Eden's connector calls a task fall on both horizons, each interval excluding zero;
  3. Sonnet-regraded false concerns are up by at most 1.0 point (upper bound of the paired interval);
  4. first-party $ per 1,000 tasks is not up (the paired interval includes zero or is below it).
- **Otherwise it stays an off trial** with its numbers, owner and end date (2026-12-10), and the note says which
  clause failed. If clause 1 alone fails with a point estimate above −2.0, the trade (calls against facts) is
  stated for the owner; if the point estimate is at or below −2.0 the switch and its code are deleted.

**What the run can show.** N1b's same shape reached a half-width of 1.3 points (minimum detectable effect 1.8).
The $0 screen predicts about −1 point (one template of 96, section 1), so clause 1 is a coin toss if the screen's
loss is real live and passes about three times in four if it is not. No seed is added or dropped after a result is
read, except on cost as N1b's section 0b allowed: a shard that hits its cap stops, and its unfinished tasks drop
from both arms' pairs.

**Spend.** Anthropic caps above sum to $6.52 (expected about $4.6 from N1b's shards); the session's own cap is $25.
Modal under $2 for this run.

## 1. The $0 screens (before the paid run)

Commands: `bun run funnel --jobs 2 --suite train1,…,train6 --seeds S [--set '{"sourceYieldEarn":true}'] --
--noise-sources 995 --limit 16 --notify-share 0.05 --call-split` (96 hidden and 96 control tasks a seed, one seed
a run: two seeds in one process ran out of memory here); `days-calls.ts --seeds 41,42 --days 8 --ask --push
payload --noise-sources 995 --notify-share 0.05 --cards packages/sim/lab/cards/cards-train.jsonl`.

| Seed | Calls a task: default → trial | Hidden surfaced (of 96) | Decoys surfaced |
| --- | --- | --- | --- |
| 41 | 33.3 → 8.2 | 77 → 76 | 69 → 69 |
| 42 | 31.0 → 8.5 | 77 → 76 | 64 → 65 |
| 43 | 33.9 → 8.8 | 76 → 75 | 68 → 69 |
| 44 | 34.2 → 9.8 | 76 → 75 | 65 → 65 |

(Seeds 42–44 ran the same rule through the session's scratch switches; seed 41 was repeated on the committed code
with the same calls and the same task-by-task diff.)

- **The one hidden task lost is the same template on every seed** (`us-travel-authorisation-refused`). Its item is
  in the held copy in both arms and is not among the push's candidates in either. The default hands it over in a
  third packet from the follow-up after a poll (`afterPoll`, reason `after-served`), which runs only because some
  unrelated live search stored a new item. The trial makes no such search for that request (4 calls against 48),
  so no follow-up runs. Running the follow-up on every request was screened on the five-source funnel: hidden 314
  → 316 of 384 (this template, seeds 41 and 42), decoys 274 → 276: one look-alike a fact, not a lever.
- **Where the calls went** (seed 41, a task, two processes): noise searches 20.1 → 0.3 and 3.2; noise listings 7.0
  → 0.1 and 1.1; the world's own five: searches 3.2–4.3 → 2.8–3.8, listings 2.4–2.7 unchanged.
- **Over 8 days** (seeds 41–42, 232 requests): request-time calls 12.3 → 6.7 a request; by day 26.6, 15.6, 19.4,
  4.9, 10.0, 5.4, 10.4, 6.8 → 8.1, 6.3, 7.2, 5.0, 7.3, 5.7, 6.4, 6.7; noise searches 5.9 → 1.5 a request; surfaced
  hidden 18 of 23 and decoys 16 of 23 in both. What is left is the user's own mailbox: 2.4 searches a request.
- **Dead ends at $0** (scratch switches, seed 41, not committed):
  - a use counts only when the item came from a live read: 33.3 → 25.6 alone; with the rule above it loses the
    same template and saves nothing more;
  - sources the lookups engaged (`Sync.engage`) exempt from the rule: 14.5 calls with no fact lost, because their
    reads reopen the pools for the noise; counted outside the pools, 9.5 calls and the same one template lost;
  - a rare word at 5 or 10 holders: 10.1 and 14.0 calls for the same facts as 2;
  - the pessimistic start without the rare word: 6.9 calls, 3 facts lost of 96 (old documents past the cut whose
    only evidence is a word in one source's sketch).

## 2. Two companions and a second pre-registration (written while run 1 was being paid for; none of its results read)

Screened after section 0 was pushed, on what the trial leaves: at 8.2 calls a task the noise connectors still took
0.3–3.2 searches (reads on a name), and over days the user's own mailbox took 2.4 searches a request.

**`sourceYieldNames` 4 (D601).** A name more than four of the user's sources mention is weak evidence for a source
with nothing used; it stays strong for a source with an item used (the user's mailbox names most people). The lab's
noise connectors name a world person in about 3% of their items, so about twenty of them mention any one person;
on the user-day bench, where every request names one, searches are 420 of 800 calls a day.

**`sourceYieldEngage` (D601).** A source the request reads nothing live of is not marked used by that request
(`Sync.engage`). Marked used, a noise connector that mentions a requested name got a deep copy (two listing pages a
tick), a daily sweep in place of the weekly one, a seat among the 64 used sources and its items sent to the card
model; the used sources' share of the cap (half) then went to them and the user's mailbox stayed cut.

$0, both on with `sourceYieldEarn` (`--set '{"sourceYieldEarn":true,"sourceYieldNames":4,"sourceYieldEngage":true}'`;
the same commands as section 1; seeds 42–44, the days and the five-source funnel ran through scratch switches before
the code was written, seed 41 again on the code as committed):

| Screen | Default | `sourceYieldEarn` | with both companions |
| --- | --- | --- | --- |
| Funnel, 995 noise, calls a task, seeds 41 / 42 / 43 / 44 | 33.3 / 31.0 / 33.9 / 34.2 | 8.2 / 8.5 / 8.8 / 9.8 | **5.2 / 5.4 / 6.4 / 7.7** |
| hidden surfaced of 384 (task diff against the default) | 306 | −4 | −4 +3 |
| control decoys surfaced of 384 (task diff) | 266 | +2 | +5 −1 |
| card calls, seed 41 (12 users) | 433 | 433 | **223** |
| 8 days, seeds 41–42: request-time calls a request | 12.3 | 6.7 | **2.4** |
| by day | 26.6 15.6 19.4 4.9 10.0 5.4 10.4 6.8 | 8.1 6.3 7.2 5.0 7.3 5.7 6.4 6.7 | 5.5 2.3 1.9 1.5 2.1 1.5 2.1 1.7 |
| background calls a user-day | 15.9 | 14.9 | **4.5** |
| the mailbox's searches a request | 2.52 | 2.44 | 0.24 |
| surfaced over days: hidden / decoys of 23 | 18 / 16 | 18 / 16 | 18 / 17 |
| Five-source funnel (`bun run funnel --jobs 4`) | 314 / 274 | | 314 / 274, no task differs |
| quality-cli at a cap of 300 (N1's `qrun.sh`): stale / updates | 12/142 | | 14/139 |
| deleted delivered / cited; recall | 3/14; 0.522 | | 3/12; 0.520 |

The four hidden tasks lost are section 1's one template on each seed; the three gained are two other templates.
`sourceYieldNames` at 16 changes nothing on seed 41 (8.2 calls); 4 and 2 read the same over days. With the names
rule alone (no `sourceYieldEngage`): 6.6 calls a task on seed 41, 5.7 a request over days.

**Pre-registration of run 2** (committed and pushed before its first paid call). Everything as section 0 (harness,
shapes, seeds, caps, metrics, at most two shards at once), with:

| arm | settings over the default |
| --- | --- |
| `eden` | none |
| `eden~earn2` | `{"sourceYieldEarn":true,"sourceYieldNames":4,"sourceYieldEngage":true}` |

`lab_fanout.py --preset bench-earn2`, runs `o1-earn2-*`. Also reported: Eden's background card spend ($ per 1,000
tasks, from the cost report), since the engage rule changes what is carded.

**Rule for run 2 (applied mechanically, after run 1's rule).** `sourceYieldNames` 4 and `sourceYieldEngage` are
promoted with `sourceYieldEarn` if section 0's four clauses hold for `eden~earn2 − eden`. Then:

- run 1 passes and run 2 passes: all three are promoted (the default becomes `eden~earn2`);
- run 1 passes, run 2 fails: `sourceYieldEarn` alone is promoted; the companions stay off trials if run 2's hidden
  point estimate is above −2.0, else they are deleted;
- run 1 fails, run 2 passes: the three are promoted together (the bundle is what was measured safe), and the note
  says run 1's interval did not clear the bar on its own;
- both fail: nothing is promoted; section 0's "otherwise" applies to each.

Run 1's results are not read before run 2 is paid for, so neither run's shape depends on the other's outcome.

## 2b. Amendment to run 2 after two reviews (committed before run 2's first paid call; no result of run 1 read)

The reviewer (`.claude/agents/reviewer.md`, REQUEST_CHANGES twice) measured what the lab could not show: **the
rare-word rule did not work at the scale it is for.** A sketch set two bits a term and folds to a fill of 0.2, so a
word one source holds was also "held" by about one sketch in 25: at 1,000 sources with vocabularies of their own,
about 27 false holders a word, and no word was ever held by "at most two". The lab hid it: its noise connectors
share 45 words (their numbered words carry a digit, which a sketch drops), so their sketches set the same few bits
and a world word missed all of them at once.

Changed:

- **Sketches set eight bits a term under `sourceYieldEarn`** (`TermSketch.probes`, `Sync`'s `sketchProbes`; folding
  to a fill of 0.28, restart at 0.45). The default's sketches are untouched (two bits, the same dump); a saved
  sketch loads only with its own number of probes, else it starts again. `o1-sketch-bytes.ts`, 995 noise connectors
  with words of their own:

  | Distinct terms a source | Two probes: bytes a user, false holders a word | Eight probes |
  | --- | --- | --- |
  | 460 | 0.76 MB, 26.8 | 1.95 MB, 0.01 |
  | 798 | 1.07 MB, 33.6 | 3.92 MB, 0.01 |
  | 1,206 | 1.75 MB, 28.4 | 4.08 MB, 0.04 |

  **The cost is memory: 2.3 to 3.7 times the two-probe sketches, up to the 4.08 MB ceiling a 1,000-source user**
  (995 sketches of 4 KB, reached near 800 terms a source), and a full-size sketch restarts after about 2,450
  distinct terms where a two-probe one holds about 11,400 (arithmetic from the constants), so a large source's
  older words are forgotten sooner. Four probes at the same bytes measured 0.16 false holders a word, which at
  eight words a request is more than one false source read a request (7.2 calls a task on seed 41 against 5.3).
  **Turning the trial on or off where users are persisted (D425) drops every saved sketch** (a sketch loads only
  with its own number of probes): a source the user does not use is listed again only by its weekly sweep (D356),
  so for up to a week a rare word cannot name it. Promotion therefore bumps `PERSIST_FORMAT`, so the change is one
  planned re-read and not a silent one.
- **The lab's noise connectors can have words of their own** (`--noise-vocab N`: funnel, pi-ab, days-calls;
  `noiseSources`). At `--noise-vocab 1000`, the three switches against the default, on the code as committed:

  | Screen | Default | Three switches |
  | --- | --- | --- |
  | Funnel, 995 noise, calls a task, seeds 41 / 42 / 43 / 44 | 30.5 / 29.7 / 33.2 / 34.4 | **5.3 / 4.9 / 6.8 / 6.8** |
  | hidden surfaced of 384 (task diff) | | +4 −1 |
  | control decoys surfaced of 384 (task diff) | | +2 −2 |
  | card calls, seed 41 | 343 | 226 |
  | 8 days, seeds 41–42: request-time calls a request | 10.4 | **3.5** |
  | by day | 29.5 12.7 10.3 8.8 4.7 5.6 6.4 5.6 | 4.8 2.2 2.0 1.8 4.7 4.4 4.0 3.6 |
  | background calls a user-day; steady calls a request | 11.8; 11.2 | 4.9; 3.8 |
  | surfaced over days: hidden / decoys of 23 | 18 / 17 | 18 / 17 |

  With two-probe sketches on the same noise the bundle read 3.9 calls a task and lost two hidden tasks of 96 (the
  rare rule dead, as the reviewer said). With realistic vocabularies the default's own pools close after a user's
  first four days (4.7–6.4 calls a request from day 5), so over days the switches' gain is mostly the first days.
  A rare-word rule read on the request's named things alone lost six hidden tasks of 96 on seed 43: every word of
  the request is needed.

**Run 2 as amended** (its rule is replaced by section 2c's: it now promotes nothing alone). Arms as section 2. Two
changes, both arms: the image is the commit that holds this section (eight-probe sketches in `eden~earn2`), and every step passes `--noise-vocab 1000` (`EXTRA` in `run.sh`), so
the default arm is no longer N1b's exact harness; the comparison is paired within the run as before.

**What run 1 can now decide.** Run 1's arm ran the rule as first built, in the lab that flatters it. It stands as
a measurement of that arm (reported in full), but **it promotes nothing on its own**: the decision matrix of
section 2 is replaced by "the three switches, with eight-probe sketches, are promoted together if run 2 passes
section 0's four clauses; otherwise they stay off (point estimate above −2.0) or are deleted". Promotion also
states the sketches' memory (above) as a cost for the owner and O2.

## 2c. One table a user in place of wider sketches, and run 3 (committed before run 3's first paid call; no result of runs 1 or 2 read)

The parent, with O2's figure of about 3.4 MB resident a live user, asked for the false-holder rate without
per-source sketch growth. A sweep of probes and fold fills (2 to 16 probes) moved along one curve (1.4 MB at 0.08
false holders a word, 1.75–1.95 MB at 0.01–0.02; 460 terms a source): a per-source filter needs two to three bytes
a (source, term) pair for this, whatever its shape.

**`RareTerms` (`rare-terms.ts`): one table a user**, sized by the distinct words their sources listed. A word is a
20-bit tag in a slot chosen by other bits of its hash, with the number of one source that holds it; a second holder
takes a second slot, a third marks the word common (one slot, no source). Four bytes a word; segments of 1 KB
doubling to 16 KB, at most 1 MB a user, past which a word with no free slot is not added. The default's sketches are
as they were (two probes; `TermSketch` is unchanged from the base), so the trial adds the table and nothing else.
`o1-rare-bytes.ts`, the lab's noise connectors:

| Sources, terms a source (distinct in all) | Default sketches: bytes, false holders a word | The table: bytes, words not added, false holders |
| --- | --- | --- |
| 995, 460 (135,484) | 0.76 MB, 26.8 | **+0.72 MB**, 0, 0 of 500 words |
| 995, 798 (209,776) | 1.07 MB, 33.6 | +1.05 MB (the cap), 22,067, 0.002 |
| 995, 231 (73,592) | 0.42 MB, 23.7 | +0.41 MB, 0, 0 |
| 995, shared words only (303) | 0.13 MB, 5.8 | +7 KB, 0, 0 |
| 45, 463 (12,423) | 36 KB, 1.1 | +81 KB, 0, 0 |

Against the eight-probe sketches of section 2b: +0.72 MB in place of +1.19 MB at 460 terms a source, a ceiling of
+1 MB in place of +2.3 MB, and no false holder in 500 unseen words where they gave 0.01–0.04 a word. Its costs: a
word new to its source is 3–5 µs to add to a full table (it scans up to 67 segments; the reviewer measured 4.4 µs,
about half at 0.72 MB), so a page of 100 items of 150 new words each is 30–70 ms on the sync's store path, with
the trial on only; no slot is ever freed, so a source that no longer lists a word still "holds" it, as in a
sketch; it is saved in the snapshot only with the trial on (`SyncSnapshot.rare`), so promotion bumps
`PERSIST_FORMAT`. A user restored without a table (saved with the trial off, or an unreadable one) has it filled
again only as sources are listed, which for unused sources is the weekly sweep: for up to a week the rare rule is
blind to them while `sourceYieldEarn` withholds their reads.

After the review of the table (REQUEST_CHANGES, fixed before run 3): a full table, or a user past 4,095 source
numbers, **fails towards "common"** (a word that could not be kept under a second source is marked common, where
it read as held by the first alone); a source the user drops has its number retired (`forgetSource`), so a source
that comes back under the same id starts with nothing; `sourceYieldRare` needs `routeSketch` (the table is
filled beside the sketch). Run 3's image is the commit with these fixes.

$0, the three switches on this structure, `--noise-vocab 1000`:

| Screen | Default | Eight-probe sketches (run 2's arm) | The table |
| --- | --- | --- | --- |
| Funnel, calls a task, seeds 41 / 42 / 43 / 44 | 30.5 / 29.7 / 33.2 / 34.4 | 5.3 / 4.9 / 6.8 / 6.8 | **4.8 / 4.3 / 6.2 / 5.3** |
| hidden surfaced of 384 (task diff) | | +4 −1 | +4 −1 |
| control decoys surfaced of 384 (task diff) | | +2 −2 | +2 −3 |
| 8 days, seeds 41–42: request-time calls a request | 10.4 | 3.5 | **1.7** |
| by day | 29.5 12.7 10.3 8.8 4.7 5.6 6.4 5.6 | 4.8 2.2 2.0 1.8 4.7 4.4 4.0 3.6 | 4.7 1.9 1.0 1.0 1.4 0.8 1.7 1.0 |
| steady calls a request (request + background) | 11.2 | 3.8 | **2.1** |
| surfaced over days: hidden / decoys of 23 | 18 / 17 | 18 / 17 | 18 / 17 |

The same tasks differ from the default on seeds 41, 42 and 44; on seed 43 the one hidden task lost is another
template than with the sketches. The calls fall because a false holder is a source read for nothing: polled,
searched, probed, and sometimes "used" by a look-alike, after which it is read on weak evidence too.

Also screened at $0 on the committed bundle and not taken (no trial opened): no word probe to a source the lookup
already searches (5.3 → 5.0 calls a task on seed 41, 6.8 → 6.0 on seed 43: D508's idea, small now as then); polling
only sources the request has evidence for (5.3 → 4.9: the polled sources nearly all have it). **Where the floor
is:** what is left one request a session is the user's own five sources, 2.4 on-demand listings and about 2
searches a task; with those five sending change notices (`--push payload` and no `--notify-share`) the same bundle
makes 2.2 calls a task with the same facts surfaced (38 of 48 on train1–3, seed 41, eight-probe build).

**Run 3 (pre-registered here).** Run 2 measures the bundle on the eight-probe sketches; what would ship is the
bundle on the table, which reads fewer sources. Run 3 repeats run 2 exactly (arms, `--noise-vocab 1000`, shapes,
seeds, caps, metrics, two shards at once; runs `o1-earn2t-*`, preset `bench-earn2`) on the commit that holds this
section. **Rule:** the three switches, with `RareTerms`, are promoted if **run 3** passes section 0's four
clauses; run 2 is reported beside it and promotes nothing by itself (its structure is not in the tree). If run 2
fails clause 1 with a point estimate at or below −2.0, run 3 is not paid for and the switches are deleted. Run 3's
caps sum to $6.47 with its regrade; with runs 1 and 2 the session's Anthropic spend stays under $16 of $25.

## 3. Dormant sources: built, screened at $0, removed after review (D602; a proposal, not a trial)

With the trials above a 1,000-source user's request-time calls are a few a request. The weekly sweep of the sources
the user does not use (D356) is then the largest cost left: on the user-day bench it lists all of them on day 8
(906 background listings that day against 125–145 on the others), about 130 calls a user-day spread over the week,
and a connector without a fetch tool is swept daily (D415: every shipped preset).

Built as `syncDormantMs`: a warm source out of the user's used set for that long, and not notifying, dropped its
synced items and was no longer polled or swept; one listing page every 28 days fed its sketch alone; strong
evidence still searched it live, and use woke it. Nothing held, so nothing delivered stale or deleted, whatever the
connector's fetch tool. At $0 (two days in place of a week, the first build, earlier lab): the user-day bench's
sweep day 923 → 243 background listings; days-calls at `--night-h 20`, seed 41: 919 sources slept, surfaced hidden 9
of 12 and decoys 9 of 12 with and without.

**Removed from the branch** (the code is in commits 83b0ec8c and d23e1449). Two reviews found seven defects in its
edges, each fixable but each new state: a waking source's poll read page after page; a restore swept every dormant
source, and the fix then made dormant any source the cap had left empty, and a notifying one deaf to its notices; a
woken source could stay unpolled; a refresh could restart a sketch and forget the source's older words. And the lab
cannot decide it: its noise connectors never hold a fact, so no run prices what a dropped copy would have found,
and Pi's `--days` compresses eight days into 36 hours and never reaches a week. A trial nothing can end is not one
(D112). **What it would take:** a suite whose facts sit in rarely used sources (or the real-data pilot,
docs/PILOT.md), dormancy saved in the snapshot (`PERSIST_FORMAT`), and the owner's view on about 100 listings a
user-day against a never-used source's held copy.
