# @eden/encoder

A small multilingual sentence encoder on CPU, for meaning-based retrieval behind an engine dependency (F2, D1142;
docs/research/f2-semantic-pool.md §4–§6). **Nothing in the engine or the servers imports it yet**: the push pool's
ranker (`pushPoolQuota`) was rejected (D1142), and a rule index over constraint cards (F10) may use it.

## Files (src/)

| File                    | Owns                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokenizer.ts`          | `UnigramTokenizer`: sentencepiece Unigram from `tokenizer.json` in TS (NFKC, Metaspace, Viterbi); exact against HF on 440 of 440 sim texts                                 |
| `encoder.ts`            | `Encoder`: the int8 ONNX model through onnxruntime-node (pinned 1.20.1; one thread, no memory arena), e5's `query: `/`passage: ` prefixes, mean pooling, L2 norm           |
| `codes.ts`              | `UserCodes`: one user's vectors as int8 codes and scales in typed arrays (optional `Projection`); `top`                                                                    |
| `ranker.ts`             | `EncoderRanker`: per-user codes, background rate-limited ingest (never on the request path), `rank`, `forget`, `remove`; `itemText` (mail headers dropped, 600 characters) |
| `onnxruntime-node.d.ts` | The runtime's types (1.20.1 does not ship its own)                                                                                                                         |

## Rules

- The model files (`tokenizer.json`, `model_quantized.onnx`) are not in the repo; `Encoder.load(dir)` throws without
  them, and a caller keeps its lexical path.
- Text reaching `ingest` or `rank` must already be redacted (D10); nothing here stores text.
- Codes are per tenant/user (D9); a caller still checks every returned id against its own user's live items.

## Measured (one thread, Bun 1.4.4)

`multilingual-e5-small` int8: 226 MB RSS loaded (model and tokenizer), 22–25 ms an item, 4–5 ms a request.
Vocabulary pruned to 70k pieces: 125 MB, but the push-pool gain fell from +21 to +9 on dev20 (§6).

## Test

```bash
bun test ./packages/encoder/src/encoder.test.ts    # fake model session; no weights needed
```
