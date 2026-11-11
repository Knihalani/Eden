# M6: a packet trimmer (each delivered item cut to the parts that carry the fact)

(This M6 is the 2026-11-11 trimmer session; the earlier M6 of D465 is docs/research/m6-heldout18.md.)

Status: 2026-11-11, branch `claude/m6-trimmer` (from main e4f3649a), session M6, decisions D920–D921. **Stopped on
its pre-registered rule (D920): the trimmer keeps 97.8% of facts on generated held-out families but 73.2% on the
sim's train5–6; deleted, no Pi run.** The lab tooling stays (D921). Paid calls go
to Anthropic directly through the lab (D97, `HAIKU_API_KEY`): **Anthropic-direct lab figures**. Caps: Anthropic $10
($8 of it for the Pi pair), Modal $40. Numbers marked **[EST]** are arithmetic or judgement; every other number comes
from a command in this note.

## 0. The problem

P2 (§3.6 of p2-push-check.md) measured that about a third of what a Haiku agent reads over a day is Eden's packets
(2,449 of 7,265 prompt tokens [EST] under the shipped kept layout, D336). A packet item today is its message cut by
`compactText`'s `pick`: the parts (sentences and lines, `messageParts`) ranked by the request's words and digits, up
to 320 bytes an item. Measured on train1 seed 41 (`--packets`, no check): a packet averages 1,011 bytes, of which 729
are item lines (3.2 items) and 282 the envelope and the candidates' lead.

The trimmer replaces `pick`'s keep set: a small learned model reads the request and each part and keeps the parts
that carry the fact the request needs (for a look-alike, the parts that show it is not the fact). Everything else
goes, as it does now past 320 bytes. No model call, no network; the model loads once per process.

## 1. Data, as the engine renders and delivers it (M3's lesson, D913)

- `hidden-funnel --packets F --packet-parts` (lab only): each delivered item re-rendered from the cache with the
  shipped options (focus, 320 bytes, year, the user's name, dense, split), its parts as `messageParts` returns them
  and the text `pick` kept. The re-render matches the packet's own line on 404 of 406 items (train1 seed 41).
- Runs: M2 v2 `synth-train` (2,128 worlds) and `synth-val` for training and tuning; `synth-test` (`--blind`) and
  train5–6 (seeds 41–44, with P7's `train5r`/`train6r`) held out; train1–4, P7's reworded and longtail suites and
  `train-rw` for training.
- **Labels** (`packages/sim/src/lab/m6/label.ts`, Haiku 5.5, ten items a call, pay once): for each planted item
  that reached a packet (the fact on a hidden task, its look-alike on a control task), its parts numbered and the
  task's detail from construction; the reply names the parts that state the fact (for a look-alike, those that show
  it is not the fact) and up to five key words, kept as the engine's tokens that occur in those parts (at most 8).
  Pilot: 122 items, $0.0064, every item labelled, 4.3 key tokens an item.

## 2. The bar (pre-registered; committed before any paid run)

**Offline screen** on held-out families: M2 v2's test split (`synth-test`) and train5–6 (train5, train6, train5r,
train6r; seeds 41–44), each read separately. A planted item keeps its key detail when every labelled key token
appears among the tokens of its trimmed line (title included). Over the planted facts whose shipped line keeps their
key detail:

1. at least **97%** keep it trimmed, on each held-out set;
2. **item-line bytes** (the `- [source] …` lines, every variant, neutral included) fall at least **50%** against the
   shipped packet on each set; whole-packet bytes are reported beside them;
3. guard: at least **95%** of the planted look-alikes keep theirs (a look-alike cut to "Strike on Thursday" without
   "called off" is a false concern made by the trimmer).

**End to end:** a Pi pair against main (the shipped default, S and `pushIndirect` on) on train, the trimmer as the
only difference: hidden facts used not worse (clustered lower bound > −2 points), confirmed concerns up by at most 1
per 1,000; agent $/1k and agent prompt tokens a task reported (aim −15%). Cap $8 Anthropic.

**Speed and size:** at most 1 ms a packet in TypeScript, at most 4 MB of shared model.

Pass all three: promote into `DEFAULT_CONFIG` with a `PARTS` entry. Fail any: delete the switch with its code and
tests the same day (D814).

## 3. Hypotheses (step 1, written before any training)

Each candidate scores a part given the request (or not), decodes a keep set per item, and is screened on the
offline bar at the threshold that holds 97% of facts on `synth-val`. Baselines: **B0** the shipped `pick` (320 bytes);
**B1** `pick` at a smaller budget (the no-model way to cut bytes: 200, 160, 120); **B2** the title and the part with
the most request words or a digit.

| # | name | what it exploits | architecture | why it could win | kill (round 1) |
| --- | --- | --- | --- | --- | --- |
| H1 | PartLR | constraint wording is lexical: "already", "cancelled", "not me", a reference | hashed word and char n-grams of the part, crossed with request overlap counts, position and flags; logistic regression, int8 | microseconds; a strong floor | val fact-keep at 50% bytes below B1's |
| H2 | PartXor | the request decides which part matters ("pay" → the account change) | M3's binarised kernel: ternary hashed-gram encoder for part and request, XNOR pair layer and a prior head | learned interaction without vectors from a pretrained model | no gain over H1 at equal bytes |
| H3 | ThreadTagger | a fact spans adjacent parts (the warning, then "ring me first") | each part a binary code, a tiny bidirectional recurrence over the item's parts | context decides the second sentence | no gain over H1 |
| H4 | ClauseCRF | half a sentence carries the point; the rest is filler | token-level keep/drop, linear-chain CRF over hashed features, cut inside parts at commas and clauses | more bytes out at the same keep | bytes not below H1's at equal keep |
| H5 | Ingest mask | an item's point does not depend on the request | H1 without the request: one keep mask an item, computed once at ingest | zero work at request time | fact-keep ≥ 3 points under H1 at equal bytes |
| H6 | Mass decoding | items differ in how many parts carry the point | calibrated scores, keep parts until a share of the item's score mass is covered (not a fixed threshold) | fewer misses on multi-part facts | no gain over fixed threshold |
| H7 | StumpForest | a few typed comparisons decide (a digit, a date the request names, a status word, first sentence) | boosted trees over ~30 integer features, exported as arrays | FrameRank's form; tiny and exact in TS | no gain over H1 |
| H8 | CharBilinear | requests come in nine languages; items are English | request and part char 3-grams, a low-rank int8 bilinear interaction | names, numbers and cognates cross languages | non-English requests' keep below English by > 3 points |
| H9 | ItemGate | most packet bytes are items that carry nothing for the request | a two-level model: whether an item's body is worth any part (else title only), then H1 on its parts | cuts noise items whole, where most bytes are | fact-keep falls where noise falls |

Round 1 runs each on a slice (local CPU, Haiku helper sessions); round 2 develops the survivors; the winners train
fully on Modal (weights on the Volume `eden-m6`), export to TypeScript with a 64/64 parity check, and are wired as
the trial switch `packetTrim`.

## 4. Rounds (val only; test and train5–6 not read)

**No-model baselines** (`baselines.py`, synth-val): `pick` at a smaller budget loses facts fast. At 240 bytes an
item it keeps 56.9% of facts' key details at 85.4% of item bytes, at 120 bytes 23.1% at 53.3%; titles alone are
16.0% of the bytes and keep 10.4%.

**Round 1** (four Haiku helper sessions; 600 synth worlds and train1–4 with their P7 and `train-rw` versions; each
candidate trained on the same slice): every candidate ranks key parts well (val AUC: h3 0.946, h2 0.934, h8 0.926,
h1 0.919–0.924, h5 0.918, h7 0.914, h4 0.861), but none reaches 97% of facts at any threshold: with every part kept
and the item fitted to its 320 bytes by score, h1 keeps 86.7%. Every miss was a key part dropped from a long item, other
parts outranking it in the fit. A within-item softmax loss made it worse (85.4%). h4 (clauses) is killed.

**The fix is architectural: subtractive trimming.** The trimmer only removes parts from `pick`'s own selection; at
threshold 0 the line is the shipped one. h1 on round 1's slice then keeps 97.1% at 75.1% of item bytes, 94.3% at
53.6%.

**Round 2** (Haiku helpers; all 2,128 synth worlds; subtractive; the best epoch at the threshold that keeps 97% of
val facts; every model overfits after its first or second epoch):

| # | val AUC | facts kept | look-alikes kept | item bytes |
| --- | --- | --- | --- | --- |
| **h3 ThreadTagger** (60k rows, 1 epoch) | **0.959** | 97.3% | 96.0% | **49.1%** |
| h2 PartXor | 0.944 | 97.1% | 94.4% | 55.7% |
| h1 PartLR | 0.941 | 97.2% | 96.6% | 60.2% |
| h8 CharBilinear | 0.947 | 97.1% | 97.0% | 60.4% |
| h5 Ingest mask (no request) | 0.936 | 97.1% | 97.1% | 65.5% |
| h1 with top-1 decoding (H6's successor) | 0.941 | 97.2% | 96.9% | 67.8% |
| h7 StumpForest | 0.919 | 97.3% | 96.4% | 69.5% |
| h9 ItemGate | 0.941 | no threshold reaches 97% | | |

Context over an item's parts is what wins (h3 against h1: the warning and the "ring me first" after it).

**Full training (Modal, 8 CPUs, all train rows: 699,579 parts, 48,575 key; 4 epochs; the epoch and the
configuration chosen on val alone, by the fewest item bytes at 97% of val facts with look-alikes at least 95%):**

| run | best epoch | facts | look-alikes | item bytes |
| --- | --- | --- | --- | --- |
| h3, 64 bits | 1 | 97.1% | 95.8% | 46.3% |
| h3, 64 bits, trained on `pick`'s parts only | 0 | 97.1% | 95.5% | 45.2% |
| **h3, 32 bits** | 1 | **97.2%** | **95.5%** | **42.9%** |

Chosen: h3 at 32 bits (commit d3a34348): each part a 32-bit sign code (a ternary table over 65,536 hashed n-gram
buckets, 2 bits a weight, batch norm folded into a scale and shift a bit) beside 27 numbers (cue words, digits, dates,
amounts, the request's words it shares, and where it stands among the item's parts); a one-layer bidirectional GRU
(32 a direction) over the item's parts in order; a linear head, plus a linear term over the same hashed features.
At its val threshold (0.0236) the bytes come off non-planted items (31.3% of theirs kept; 81% of val's item bytes)
while planted items keep 94.2% of theirs.

**TypeScript** (`trim.ts`): parity 69/69 keep decisions identical with the trainer (max score difference 1.7e-7);
the weights file is 1.15 MB; on 568 synth-val no-check packets (3.46 items each) p50 0.63–0.68 ms, p90 1.07–1.17 ms
a packet (three runs, `bench.ts`). The first port (string-built CRC n-grams, a bit-unpacked table, allocating GRU)
took 1.72 ms p50 at 64 bits.

## 5. Held-out screen (read once, at d3a34348) and the decision

Real funnel packets, the engine's trimmer in the loop (`--set '{"packetTrim":true}'`, `screen_funnel.py` against
the same suites and seeds with the default): `synth-test` (`--blind`, 293 worlds) and train5, train6, train5r,
train6r (seeds 41–44).

| held-out set | tasks | facts kept | look-alikes kept | item bytes | packet bytes |
| --- | --- | --- | --- | --- | --- |
| synth-test (M2 v2 test families) | 6,618 | **97.8%** (798 / 816) | **96.2%** (691 / 718) | **42.8%** | 58.4% |
| train5–6 and their rewordings | 1,536 | **73.2%** (221 / 302) | **79.4%** (212 / 267) | 53.2% | 67.9% |

**Stop on the pre-registered rule (D920):** clauses 1 and 3 fail on train5–6, so `packetTrim` is deleted with its
code and tests (they are in commit d3a34348; the weights are on the Volume `eden-m6`, `runs/m-h3c`). The Pi pair was
not run: $0 of its $8.

Not a harness fault: of the 81 train5–6 facts lost, 38 were cut to their title alone ("Re: January!" without "the
spare room is yours on the 9th, I've already told Sami") and 43 lost a key part; on synth-test 7 and 11. The sim's
hand-written templates are written differently from the generated worlds the model mostly learned from (train1–4
and their versions are about a tenth of the training rows), and a model that keeps 97.8% on unseen generated
families keeps 73.2% on unseen hand-written ones: M3's lesson (D913) again, this time on item text rather than
retrieval.

## 6. What it leaves

- **Subtractive is the shape a trimmer needs.** Ranking an item's parts afresh and fitting the best to the budget
  lost 13% of facts with every part allowed; removing parts only from `pick`'s own selection starts at the shipped
  line and lets the threshold buy bytes.
- **Context over an item's parts carries the decision.** A tiny bidirectional GRU over per-part sign codes beat a
  binarised pair net, a linear model, a bilinear one and trees by 7–20 points of bytes at the same keep on val.
- **At 97% keep the bytes come off items that carry nothing for the request.** Planted facts and look-alikes keep
  about 94% of their bytes; non-planted items keep 31%. Under the shipped push check (S) most of those items no
  longer reach the packet, so the live cut would be well under the offline one, and with S's packets about 1,061 of
  a Haiku agent's 5,534 re-read prompt tokens a task (P2 §3.6) and the lead and envelope fixed, the −15% aim was
  out of reach from item text alone **[EST]**.
- **A successor** would train on the sim's hand-written families at a real share (or on items S delivers) and be
  screened on a held-out set nobody has read (train5–6 are read now; heldout19 is not for this).

## 7. Spend and reproduce

Anthropic **$1.44** of $10 (Haiku 5.5 part labels for 27,179 planted items, `.local/m6/ledger.jsonl`); no Pi or
other paid run. Modal: three 8-CPU training runs of about 20 minutes and the Volume `eden-m6`, about $1 **[EST]**.
Haiku helper sessions ran rounds 1 and 2 on their own machines (no paid calls).

```bash
bun run funnel --suite synth-train --seeds 1,…,30 --jobs 3 -- --neutral --packets D.jsonl --packet-parts  # 30 a run
bun run funnel --blind --suite synth-test --seeds … -- --neutral --packets T.jsonl --packet-parts          # held out
bun packages/sim/src/lab/m6/label.ts D*.jsonl --out L.jsonl --spend-cap 3                  # pay once, ~$0.00005 an item
python3 -I packages/sim/lab/m6/prep.py --labels L.jsonl --out DIR D*.jsonl T*.jsonl
python3 -I packages/sim/lab/m6/baselines.py DIR/items.jsonl --sets val
python packages/sim/lab/m6/cands.py --items DIR/items.jsonl --arch h3 --within-pick --bits 32 --buckets 65536 \
  --lr 0.005 --epochs 4 --out RUN                               # torch CPU; Modal: packages/sim/modal/m6_trim.py
# the deleted switch (commit d3a34348): copy RUN/trim-model.json to packages/engine/models/, then
bun run funnel … --set '{"packetTrim":true}' -- --neutral --packets A.jsonl --packet-parts
python3 -I packages/sim/lab/m6/screen_funnel.py --labels L.jsonl --base T.jsonl --arm A.jsonl
```

Funnel dumps need about 30 seeds a process group (memory grows with seeds in one process; 100 were killed).
