# O1: a source earns its live reads (`sourceYieldEarn`, connector calls at 1,000 sources)

Status: finished 2026-11-11 on branch `claude/o1-calls` (from `claude/lucid-hypatia-v9wqk5` at 3ee07ac6; the base
merged in again at 6af844fe). Decisions D600–D603. Paid calls: Anthropic API only, the Modal Secret
`HAIKU_API_KEY`, `claude-haiku-5-5` in every role, `claude-sonnet-5-5` for regrades, lab provider (D97):
**Anthropic-direct lab figures**, not the OpenRouter route the servers ship. Train suites only; `heldout18` is not
run or read. Every rule below was committed and pushed before the paid calls it decides. **Spent: $18.13
Anthropic** of the $25 cap by the session's ledger (three runs $11.61, the days check $2.83, a first attempt at it
lost with the container, about $2.50 estimated, smokes $0.04, Sonnet regrades $1.16; parts rounded). **Result: the three switches
are in `DEFAULT_CONFIG` and the pooled rule they replace is deleted (D603).**

## The result in plain words

- **What changed.** A source the user has never had anything used from is read live only when the request gives
  strong evidence for it: a name it mentioned, or a word that at most two of the user's sources hold. A name most
  sources mention does not count for such a source, and a source a request reads nothing of is not treated as "in
  use". Before, every new user's requests read dozens of unrelated connectors until a learned rate shut them off.
- **Connector calls a task at about 1,000 sources, live (run 3, paired):** **23.3 → 5.5** one request a session
  (−17.9, −18.8..−17.0) and **7.3 → 2.4** over a user's eight days (−4.8, −5.4..−4.3); on 24 more users over days
  **8.3 → 1.9** (−6.3, −6.7..−6.0).
- **Hidden facts raised: level.** Run 3, 2,405 pairs: −0.1 points (−1.7..+1.6), 56.1% against 56.2%; the bar was a
  lower bound above −2.0. Over days, 24 new users, every answer graded by Sonnet: +3.0 points (−0.9..+6.7 with
  users as clusters, 332 pairs); the bar was above −4.0.
- **False concerns level** (0.1% against 0.0%, +0.1 points, +0.0..+0.2), **wall time level** (−0.014 s), **dollars
  for the agent and Eden a task level** (+$0.002 per 1,000 tasks, −0.002..+0.006). With Eden's background cards the
  steady first-party bill falls ($0.58 → $0.33 per 1,000 tasks one request a session): unrelated connectors' items
  no longer go to the card model.
- **On a per-call connector plan** (list prices, assumed; steady): Zapier MCP $645 → $175 per 1,000 tasks one
  request a session and $213 → $77 over days.
- **What it costs.** One table a user of which few sources hold each word: 4 bytes a word, +0.72 MB for the lab's
  1,000-source user (about +6% of the 11.4 MB heap O4 measured for such a user), at most 1 MB. An ask's "not
  searched" line now names nearly every source for a new user.
- **Where the floor is now.** What is left one request a session is the user's own sources: about 2.4 on-demand
  listings and 2 searches a task. When those five send change notices the same rule makes 2.2 calls a task at $0.

## In plain words, as written before the first paid run

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
it read as held by the first alone); a source the user drops has its number retired (`forgetSource`) and its slots are
taken over as words are added, so a source that comes back under the same id starts with nothing and one that
comes and goes neither turns its words common nor uses a slot each time (each return still uses one of the
4,095 source numbers); `sourceYieldRare` needs `routeSketch` (the table is
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

## 2d. Runs 1 and 2, and a days check registered before run 3 was read

Runs 1 and 2 were read together once both were paid (`packages/sim/lab/o1/earn/`, `earn2/`: `bench.txt`,
`bench-horizons.txt`, `pair-*.txt`, `pi-cost-*.txt`, manifests). `trial − default`, Haiku-graded hidden as
registered, Sonnet's verdict on flagged concerns:

| | Run 1: `eden~earn` (first build, shared noise words) | Run 2: `eden~earn2` (eight-probe sketches, `--noise-vocab 1000`) |
| --- | --- | --- |
| Hidden raised, pooled | **+1.0 points (−0.3..+2.3)**, n 2,304, 57.8 / 56.8; MDE 1.8 | **+1.2 points (−0.5..+2.9)**, n 2,405, 56.1 / 55.0; MDE 2.4 |
| short, seeds 41–44 | +1.1 (−2.1..+4.4), n 378 | +0.5 (−2.6..+3.6), n 384 |
| short, seeds 45–64 | +1.3 (−0.2..+2.6), n 1,825 | +1.7 (−0.2..+3.7), n 1,920 |
| days, 8 users | −4.0 (−13.0..+3.8), n 101 | −6.9 (−14.0..−0.9), n 101 |
| Eden's calls a task, short (paired, 1:1) | 26.7 → 9.3: −17.4 (−18.3..−16.6) | 23.3 → 6.2: −17.1 (−18.0..−16.1) |
| Eden's calls a task, days (1:1:8) | 11.9 → 5.7: −6.1 (−6.9..−5.4) | 7.9 → 2.7: −5.2 (−5.8..−4.5) |
| False concerns, regraded | 0 against 0 of 1,257 | 2 against 1 of 1,272: +0.1 points (−0.2..+0.4) |
| $ per 1,000 tasks, agent + Eden per task | +0.002 (−0.001..+0.005) | +0.001 (−0.003..+0.004) |
| Wall mean | +0.006 s (−0.015..+0.027) | +0.003 s (−0.022..+0.027) |
| `ask_context` calls a task | +0.008 (−0.005..+0.021) | +0.015 (−0.003..+0.035) |

Run 2's cost report, each arm's own tasks (not paired; list prices, assumed): first-party steady $ per 1,000 tasks
(agent + Eden + background cards) 0.575 → 0.335 short and 0.390 → 0.289 over days (the noise connectors' items no
longer reach the card model); Eden's background calls a task 1.99 → 1.34 and 1.00 → 0.53; Zapier MCP steady $640 →
$194 short and $230 → $85 over days; Composio $8.01 → $2.58 and $3.06 → $1.27.

**The rule's four clauses hold in both runs** (lower bounds −0.3 and −0.5 against −2.0; calls down on both
horizons; concerns up at most +0.4; dollars level). By section 2c neither promotes anything: run 3 does.

**The days horizon reads below zero in both runs, on the same 101 tasks of the same 8 users.** What was checked:

- **Reach is not worse.** The planted item was in a packet or an ask's answer of its request in 52 tasks with the
  trial and 51 without in run 2 (one lost, two gained), 51 and 53 in run 1 (five lost, three gained); short, run 2:
  278 against 275 of 384 and 1,219 against 1,189 of 1,920.
- **The grader moves it.** Every days hidden answer regraded by Sonnet (`regrade.ts --kinds hidden`,
  `bench_report.py --sonnet all`): run 2 **−2.0 points (−8.6..+4.0)**, 3 tasks raised by the trial alone and 5 by
  the default alone; run 1 −5.9 (−13.0..+0.0), 3 against 9.
- A day's requests share one transcript, so these task-level and template-level intervals are too narrow by 1.5 to
  3 times (D519), and the two runs are two readings of one set of tasks (D544).

So nothing found says Eden hands the agent less over days, and nothing rules out a loss of a few points there.

**Days check (registered here, before run 3's results are read; paid after run 3).** The same two arms as run 3
(the table, `--noise-vocab 1000`, the image at run 3's commit), `--days 8`, **24 users on seeds 49–72** (none of
41–48), two shards at once, cap $0.20 a user ($4.80; expected about $2.6); every hidden answer of both arms
regraded by `claude-sonnet-5-5` (cap $1.00), Sonnet's verdict replacing Haiku's. **Rule:** the days horizon is
accepted if the paired hidden effect's 95% interval **with users resampled as clusters** (`bench_report.py`'s "by
seed" interval: users are independent where a day's tasks are not) has its **lower bound above −4.0 points**.
Otherwise the switches are not promoted whatever run 3 reads, and stay off trials with the days loss stated. (This section was committed while run 3's first step ran: its later steps' image is this commit, which differs
from the first step's, 20e36961, by this note alone.) The
check is run whatever run 3's days arm reads; run 3's own days pairs are reported beside it and not pooled into
the rule.

## 2e. Run 3, the days check and the decision (D603)

**Run 3** (`packages/sim/lab/o1/earn2t/`; the table build, `--noise-vocab 1000`; image 20e36961 for its first step
and f69b260d, the same code, for the rest; 0 ungraded, the 16 answers Haiku flagged regraded by Sonnet). `eden~earn2 − eden`:

| | Effect | Levels (trial / default) |
| --- | --- | --- |
| Hidden raised, pooled | **−0.1 points (−1.7..+1.6)**, n 2,405, 139 templates; by seed −1.5..+1.2; MDE 2.4 | 56.1 / 56.2 |
| short, seeds 41–44 | −3.9 (−8.1..+0.0), n 384 | 58.9 / 62.8 |
| short, seeds 45–64 | +0.4 (−1.4..+2.2), n 1,920 | 55.3 / 54.8 |
| days, 8 users | +4.0 (−2.1..+11.0), n 101 | 61.4 / 57.4 |
| Eden's calls a task, short (paired) | **−17.9 (−18.8..−17.0)** | 5.45 / 23.32 |
| Eden's calls a task, days (1:1:8) | **−4.8 (−5.4..−4.3)** | 2.44 / 7.27 |
| False concerns, Sonnet-regraded | +0.1 points (+0.0..+0.2), n 1,272; 1 against 0 | 0.1 / 0.0 |
| the same, Haiku's verdicts | −0.3 points (−1.1..+0.3); 6 against 10 | 0.5 / 0.8 |
| $ per 1,000 tasks, agent + Eden per task | +0.002 (−0.002..+0.006) | 0.426 / 0.424 |
| Wall mean | −0.014 s (−0.040..+0.011) | 1.963 / 1.977 |
| `ask_context` calls a task | +0.015 (−0.007..+0.037) | 0.369 / 0.354 |

Cost report, each arm's own tasks (list prices, assumed; steady): first-party with background cards 0.581 → 0.331
short and 0.386 → 0.296 over days; Eden's background calls a task 2.03 → 1.33 and 0.98 → 0.54; Zapier MCP $645 →
$175 and $213 → $77; Composio $8.08 → $2.37 and $2.86 → $1.19. The backfill is unchanged: about 1,005 listings a
new user, once.

After the review of the promoted tree (APPROVE, 10f140e9): a dropped source's number was never given out again, so
a user whose 1,000 sources were dropped and listed five times had no numbers left and the rare-word rule went quiet
for good (the reviewer's probe: 95 of 1,000 sources named on the fifth listing, none on the sixth). The table now
takes dropped sources' numbers back in one pass when they run out (`renumber`; 4,094 sources at once), tested over
seven such listings and a save; `sourceYieldRare` and `sourceYieldNames` have ranges in `config-check.ts`.

**The rule, applied.** Clause 1: the pooled lower bound is −1.7, above −2.0. Clause 2: calls fall on both
horizons, both intervals below zero. Clause 3: concerns' upper bound +0.2, under +1.0. Clause 4: the dollar
interval holds zero. **Run 3 passes.** The seeds-41–44 reading (−3.9) is four seeds on which run 2 read +0.5; it
is reported, and by D544 it is not evidence. The days reading, +4.0, is the third of the same 101 tasks (−4.0,
−6.9 before).

**The days check** (`packages/sim/lab/o1/earn2d/`; section 2d's registration; image f69b260d). 24 users, seeds
49–72, `--days 8`, 3,114 task runs an arm, 0 ungraded; all 664 hidden answers regraded by Sonnet:

| | Effect | Levels (trial / default) |
| --- | --- | --- |
| Hidden raised, Sonnet-graded | **+3.0 points; users as clusters −0.9..+6.7**; by template −0.9..+7.0; n 332 | 51.5 / 48.5 |
| the same, Haiku-graded | +3.0 (by seed −1.2..+7.2) | 53.6 / 50.6 |
| Eden's calls a task (1:1:8) | **−6.3 (−6.7..−6.0)** | 1.91 / 8.25 |
| False concerns (Haiku's verdicts) | −0.1 points (−0.6..+0.4), n 2,782 | 0.8 / 0.9 |
| $ per 1,000 tasks, agent + Eden per task | −0.006 (−0.008..−0.004) | 0.366 / 0.372 |
| Wall mean | −0.068 s (−0.118..−0.022) | 1.553 / 1.621 |

Steady first-party $ per 1,000 tasks 0.415 → 0.324; Zapier MCP $241 → $62. **The rule, applied:** the
user-clustered lower bound is −0.9, above −4.0: the days horizon is accepted. McNemar on the pairs: the trial
alone raised the fact in 27 tasks, the default alone in 17 (p 0.17). The earlier days gap was the eight users.

**Deviations.** The days check's first attempt (one fan-out of 24 shards) was lost when the session's container
restarted with 22 shards finished: the fan-out writes results only when it ends. Nothing of it was read; its
spend, about $2.50, is estimated from run 3's cost a user and is in the ledger as an estimate. It was run again in
four fan-outs of six users, the same seeds, image and rule. Run 3's later steps and the days check ran on f69b260d
where section 2c said "the commit that holds this section" (the commits between differ by docs, review fixes to
`RareTerms` and report scripts; the engine and lab code of both arms is that of 20e36961 except `RareTerms`'
fail-towards-common and `forgetSource`, which were committed before run 3). Run 2's smoke ($0.018) ran one
commit before its amendment. The concern regrade of the days check was not run (its hidden regrade was the
registered one); its concern figures are Haiku's.

**Decision (D603).** `sourceYieldEarn`, `sourceYieldNames` 4 and `sourceYieldEngage` are in `DEFAULT_CONFIG` (part
`sync`), with `RareTerms`. The pooled rule (`poolSpent`, the pools, `sourceYieldFloor`, `sourceYieldWords`) is
deleted; `PERSIST_FORMAT` is 3. Changed with the promotion and not in any paid arm: the ask's line for a source
it did not search now reads "nothing in the request points there" (it said "nothing found there has been used
lately", untrue of a source never read); the table is filled with `routeSketch` off too; `sourceYieldEngage` acts
only with `sourceYieldEarn`. On the promoted tree: `CHECK_COLD=1 bun run check` green, eval 0.65 / 0.52 / 0, the
five-source funnel 314 / 274, the 995-source screen (seed 41, `--noise-vocab 1000`) 4.8 calls a task with no task
different from the default before it (30.5).

**What this leaves.** The user's own sources' on-demand listings (2.4 a task) are the floor without notices. The
weekly sweep of unused sources is now the largest standing cost (section 3). A new user's backfill is about 1,005
listings. Memory for the table and its 3–5 µs a new word on the store path are now the default's (section 2c);
`users.bench.ts`'s figures predate it.

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
