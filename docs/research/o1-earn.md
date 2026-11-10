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
