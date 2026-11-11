# M6: a packet trimmer (each delivered item cut to the parts that carry the fact)

Status: 2026-11-11, branch `claude/m6-trimmer` (from main e4f3649a), session M6, decisions D920–D929. Paid calls go
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
