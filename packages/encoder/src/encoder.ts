/**
 * A small multilingual sentence encoder on CPU (F2, docs/research/f2-semantic-pool.md §4): an int8 ONNX model
 * (`Xenova/multilingual-e5-small`'s `model_quantized.onnx`, 118 MB, not in the repo) run through onnxruntime-node,
 * with the TypeScript tokenizer. e5's conventions: "query: " before a request, "passage: " before an item; the
 * vectors are the token states mean-pooled over the mask and L2-normalised (384 dimensions).
 *
 * Measured (Bun 1.4.4, one thread, memory arena off): about +131 MB RSS for the model and +55 MB for the tokenizer,
 * 22–25 ms an item of up to 128 tokens and 4–5 ms a request.
 *
 * One thread, no arena: the encoder runs beside the event loop's work and must not hold its peak memory. `load`
 * throws when the files or the runtime are missing; a caller treats that as "no encoder" and keeps its lexical path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UnigramTokenizer } from "./tokenizer";

/** What a caller needs of the runtime's session (onnxruntime-node's `InferenceSession`, narrowed for tests). */
export interface Session {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
}

/** The runtime's tensor constructor (onnxruntime-node's `Tensor`). */
export type TensorOf = new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;

export const QUERY = "query: ";
export const PASSAGE = "passage: ";

export class Encoder {
  constructor(
    readonly tokenizer: UnigramTokenizer,
    private readonly session: Session,
    private readonly Tensor: TensorOf,
    /** Tokens an input is cut to, `<s>` and `</s>` included. */
    readonly maxTokens = 128,
  ) {}

  /**
   * Loads `tokenizer.json` and `model_quantized.onnx` from `dir` with onnxruntime-node (one thread, no memory arena).
   * Throws when either is missing or the runtime cannot load.
   */
  static async load(dir: string, maxTokens = 128): Promise<Encoder> {
    const tokenizer = UnigramTokenizer.fromJson(readFileSync(join(dir, "tokenizer.json"), "utf8"));
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(join(dir, "model_quantized.onnx"), {
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
    return new Encoder(tokenizer, session as unknown as Session, ort.Tensor as unknown as TensorOf, maxTokens);
  }

  /** L2-normalised mean-pooled vectors of `texts` (prefix them with `QUERY` or `PASSAGE`), in one batch. */
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const enc = texts.map((t) => this.tokenizer.encode(t, this.maxTokens));
    const L = Math.max(...enc.map((e) => e.length));
    const ids = new BigInt64Array(texts.length * L);
    const mask = new BigInt64Array(texts.length * L);
    enc.forEach((e, r) =>
      e.forEach((k, c) => {
        ids[r * L + c] = BigInt(k);
        mask[r * L + c] = 1n;
      }),
    );
    const dims = [texts.length, L];
    const feeds: Record<string, unknown> = {
      input_ids: new this.Tensor("int64", ids, dims),
      attention_mask: new this.Tensor("int64", mask, dims),
    };
    if (this.session.inputNames.includes("token_type_ids"))
      feeds.token_type_ids = new this.Tensor("int64", new BigInt64Array(texts.length * L), dims);
    const out = (await this.session.run(feeds))[this.session.outputNames[0]!]!;
    const h = out.data as Float32Array;
    const D = out.dims[2]!;
    return enc.map((e, r) => {
      const v = new Float32Array(D);
      for (let c = 0; c < e.length; c++) {
        const at = (r * L + c) * D;
        for (let d = 0; d < D; d++) v[d]! += h[at + d]!;
      }
      let n = 0;
      for (let d = 0; d < D; d++) n += v[d]! * v[d]!;
      n = Math.sqrt(n) || 1;
      for (let d = 0; d < D; d++) v[d]! /= n;
      return v;
    });
  }
}
