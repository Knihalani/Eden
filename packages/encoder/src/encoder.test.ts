import { describe, expect, test } from "bun:test";
import { Encoder, EncoderRanker, itemText, project, stamp, UnigramTokenizer, UserCodes, type Session } from "./index";

// @eden/encoder (F2): the tokenizer's Viterbi, the int8 code store and the background ranker, with a fake model
// session (the real model is 118 MB and not in the repo; `packages/sim/lab/f2-pool/encoder-probe.ts` checks it).

const VOCAB: [string, number][] = [
  ["<s>", 0],
  ["<pad>", 0],
  ["</s>", 0],
  ["<unk>", 0],
  ["▁", -3],
  ["▁pay", -2],
  ["▁pa", -4],
  ["y", -4],
  ["▁in", -3],
  ["voice", -3],
  ["▁invoice", -3.5],
  ["i", -6],
  ["n", -6],
];

describe("UnigramTokenizer", () => {
  const tok = new UnigramTokenizer(VOCAB);
  test("Viterbi picks the best-scoring split; <s> and </s> wrap the ids", () => {
    // "▁invoice" (−3.5) beats "▁in" + "voice" (−6); "▁pay" (−2) beats "▁pa" + "y" (−8).
    expect(tok.encode("pay invoice")).toEqual([0, 5, 10, 2]);
  });
  test("an unknown character is <unk>, and a run of them is one; NFKC and whitespace are folded", () => {
    expect(tok.encode("pay    €€")).toEqual([0, 5, 4, 3, 2]);
    expect(tok.encode("ｐａｙ")).toEqual([0, 5, 2]);
  });
  test("cut to max ids, </s> kept", () => {
    expect(tok.encode("pay pay pay pay", 4)).toEqual([0, 5, 5, 2]);
  });
  test("fromJson refuses a model that is not Unigram", () => {
    expect(() => UnigramTokenizer.fromJson(JSON.stringify({ model: { type: "BPE" } }))).toThrow(/Unigram/);
  });
});

describe("UserCodes", () => {
  test("int8 codes rank like the vectors; remove frees a slot; growth keeps codes", () => {
    const u = new UserCodes(3, 1);
    u.put("a", new Float32Array([1, 0, 0]), 7);
    u.put("b", new Float32Array([0, 1, 0]));
    u.put("c", new Float32Array([0.7, 0.7, 0]));
    expect(u.top(new Float32Array([1, 0.1, 0]), 2)).toEqual(["a", "c"]);
    expect(u.stampOf("a")).toBe(7);
    u.remove("a");
    expect(u.top(new Float32Array([1, 0, 0]), 3)).toEqual(["c", "b"]);
    u.put("d", new Float32Array([0, 0, 1]));
    expect(u.size).toBe(3);
    expect(u.top(new Float32Array([0, 0, 1]), 1)).toEqual(["d"]);
    expect(u.top(new Float32Array([1, 0, 0]), 3, (id) => id !== "c")[0]).not.toBe("c");
  });
  test("a projection's output dimensions are the codes'", () => {
    const p = { mean: new Float32Array([1, 0]), matrix: new Float32Array([2, 0, 0, 1, 0, 0]), dims: 3 };
    // (2, 3) less the mean is (1, 3); 1 × row (2, 0, 0) + 3 × row (1, 0, 0).
    expect([...project(new Float32Array([2, 3]), p)]).toEqual([5, 0, 0]);
  });
});

/** A fake model: a token's state is a one-hot of its id modulo 4, so a text's vector is its ids' histogram. */
function fakeEncoder(calls: string[][] = []): Encoder {
  const session: Session = {
    inputNames: ["input_ids", "attention_mask"],
    outputNames: ["last_hidden_state"],
    async run(feeds) {
      const ids = feeds.input_ids as { data: BigInt64Array; dims: number[] };
      const [B, L] = ids.dims as [number, number];
      const data = new Float32Array(B * L * 4);
      for (let i = 0; i < B * L; i++) data[i * 4 + (Number(ids.data[i]) % 4)] = 1;
      return { last_hidden_state: { data, dims: [B, L, 4] } };
    },
  };
  class Tensor {
    constructor(
      readonly type: string,
      readonly data: BigInt64Array,
      readonly dims: number[],
    ) {}
  }
  const enc = new Encoder(new UnigramTokenizer(VOCAB), session, Tensor as never);
  const embed = enc.embed.bind(enc);
  enc.embed = async (texts) => {
    calls.push([...texts]);
    return embed(texts);
  };
  return enc;
}

describe("EncoderRanker", () => {
  const alice = { tenantId: "t", userId: "alice" };
  const bob = { tenantId: "t", userId: "bob" };

  test("items are embedded in the background, not by ingest; rank reads only its own user's codes", async () => {
    const calls: string[][] = [];
    const r = new EncoderRanker(fakeEncoder(calls), null, { perSecond: 1_000, batch: 2 });
    r.ingest(alice, [
      { id: "a1", title: "pay", text: "invoice" },
      { id: "a2", title: "in", text: "voice" },
    ]);
    expect(calls.length).toBe(0);
    expect(await r.rank(alice, "pay", 5)).toEqual([]);
    await r.drained();
    expect(r.held(alice)).toBe(2);
    expect(r.held(bob)).toBe(0);
    expect(await r.rank(bob, "pay", 5)).toEqual([]);
    expect((await r.rank(alice, "pay", 5)).sort()).toEqual(["a1", "a2"]);
    r.stop();
  });

  test("an unchanged item is not embedded again; a changed one is; forget and remove drop codes", async () => {
    const calls: string[][] = [];
    const r = new EncoderRanker(fakeEncoder(calls), null, { perSecond: 1_000, batch: 4 });
    const it = { id: "a1", title: "pay", text: "From: x@y.z\ninvoice" };
    r.ingest(alice, [it]);
    await r.drained();
    r.ingest(alice, [it]);
    await r.drained();
    expect(r.stats.embedded).toBe(1);
    expect(r.stats.skipped).toBe(1);
    r.ingest(alice, [{ ...it, text: "pay" }]);
    await r.drained();
    expect(r.stats.embedded).toBe(2);
    r.remove(alice, ["a1"]);
    expect(r.held(alice)).toBe(0);
    r.ingest(bob, [it]);
    await r.drained();
    r.forget(bob);
    expect(r.held(bob)).toBe(0);
    r.stop();
  });

  test("a queue is bounded: the oldest queued items are dropped", () => {
    const r = new EncoderRanker(fakeEncoder(), null, { maxQueued: 2 });
    r.ingest(
      alice,
      [1, 2, 3].map((i) => ({ id: `a${i}`, title: "pay", text: "" })),
    );
    expect(r.stats.dropped).toBe(1);
    r.stop();
  });

  test("a model failure is counted and the queue moves on; an aborted rank answers nothing", async () => {
    const enc = fakeEncoder();
    enc.embed = async () => {
      throw new Error("model down");
    };
    const r = new EncoderRanker(enc, null, { perSecond: 1_000 });
    r.ingest(alice, [{ id: "a1", title: "pay", text: "" }]);
    await r.drained();
    expect(r.stats.failures).toBe(1);
    const stop = new AbortController();
    stop.abort();
    expect(await r.rank(alice, "pay", 5, stop.signal)).toEqual([]);
    r.stop();
  });

  test("the embedded text drops mail header lines and keeps 600 characters; the stamp follows the text", () => {
    const t = itemText("Re: deposit", `From: a@b.c\nTo: d@e.f\nDate: Mon\n${"x".repeat(700)}`);
    expect(t.startsWith("passage: Re: deposit. xxx")).toBe(true);
    expect(t).not.toContain("From:");
    expect(t.length).toBe("passage: Re: deposit. ".length + 600);
    expect(stamp("a")).not.toBe(stamp("b"));
  });
});
