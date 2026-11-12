import { describe, expect, test } from "bun:test";
import { Budget, type ChatRequest, type ChatResponse, type Model } from "@eden/llm";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import {
  CHECK_LEAN_STOP,
  CHECK_SYSTEM,
  CHECK_SYSTEM_LEAN,
  checkKey,
  checkMessages,
  closeLean,
  PushChecker,
  type PushCheckInput,
} from "./push-check";

// `pushCheckLeanStop` (F7, a trial): the check's yeses first, its reply stopped at the first no.

const INPUT: PushCheckInput = {
  request: "Pay the Harlow venue deposit invoice.",
  today: "2026-10-27",
  items: ["hold", "plain", "dated"].map((id) => ({
    id: `mail:${id}`,
    hash: id,
    source: "mail",
    title: `Harlow ${id}`,
    text: `About the Harlow ${id}.`,
    date: "2026-10-26",
    from: "",
  })),
};

/** A model that writes `reply` and, as Anthropic does, cuts it before the first of the request's stop sequences. */
function stopping(reply: string): Model & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    id: "stopping",
    calls,
    async chat(request: ChatRequest): Promise<ChatResponse> {
      calls.push(request);
      let text = reply;
      let stopped = false;
      for (const s of request.stop ?? []) {
        const at = text.indexOf(s);
        if (at >= 0) {
          text = text.slice(0, at);
          stopped = true;
        }
      }
      return {
        text,
        usage: { inputTokens: 100, outputTokens: Math.ceil(text.length / 4), cachedInputTokens: 0 },
        costUsd: 0,
        model: "stopping",
        latencyMs: 0,
        truncated: false,
        stopped,
      };
    },
  };
}

const yes = (i: number) => `{"i":${i},"on":"the Harlow deposit","hits":"the deposit invoice","act":true}`;
const no = (i: number, act = '"act":false') => `{"i":${i},"on":"another venue","hits":"none",${act}}`;

async function ask(reply: string, lean = true) {
  const model = stopping(reply);
  const checker = new PushChecker({ model, budget: new Budget() });
  const read = await checker.check(
    { tenantId: "t", userId: "u" },
    "s",
    { ...INPUT, ...(lean ? { lean: true } : {}) },
    new AbortController().signal,
  );
  return { read, model, checker };
}

describe("pushCheckLeanStop (F7)", () => {
  test("off in the default; needs a checker and the check", () => {
    expect(DEFAULT_CONFIG.pushCheckLeanStop).toBe(false);
    expect(() => checkEngineConfig({ pushCheckLeanStop: true }, { deps: { reader: true } })).toThrow(/checker/);
    expect(checkEngineConfig({ pushCheckLeanStop: true }, { deps: { checker: true } })).toEqual({
      pushCheckLeanStop: true,
    });
  });

  test("the lean instructions differ from the shipped ones only in the order they ask for", () => {
    expect(CHECK_SYSTEM_LEAN).not.toBe(CHECK_SYSTEM);
    expect(CHECK_SYSTEM_LEAN).toContain('first every item whose "act" is true');
    const [a, b] = [CHECK_SYSTEM.split(/\s+/), CHECK_SYSTEM_LEAN.split(/\s+/)];
    const head = a.findIndex((w, i) => w !== b[i]);
    let tail = 0;
    while (a.at(-1 - tail) === b.at(-1 - tail)) tail++;
    expect(a.slice(head, a.length - tail).join(" ")).toBe("the most decisive first, at most 6;");
    expect(checkMessages({ ...INPUT, lean: true })[0]!.content).toBe(CHECK_SYSTEM_LEAN);
    expect(checkMessages(INPUT)[0]!.content).toBe(CHECK_SYSTEM);
    // A recorded shipped reply never answers a lean request, nor the other way round.
    expect(checkKey({ ...INPUT, lean: true })).not.toBe(checkKey(INPUT));
  });

  test("sends the stop only when lean; the shipped check still has none", async () => {
    const { model } = await ask(`{"items":[]}`);
    expect(model.calls[0]!.stop).toEqual(CHECK_LEAN_STOP);
    const shipped = await ask(`{"items":[]}`, false);
    expect(shipped.model.calls[0]!.stop).toBeUndefined();
  });

  test("a reply stopped at its first no keeps the yeses before it", async () => {
    const { read } = await ask(`{"items":[${yes(1)},${yes(3)},${no(2)}]}`);
    expect([...read.yes!]).toEqual(["mail:hold", "mail:dated"]);
    // Either spacing stops it.
    const spaced = await ask(`{"items":[${yes(3)},${no(2, '"act": false')},${yes(1)}]}`);
    expect([...spaced.read.yes!]).toEqual(["mail:dated"]);
  });

  test("a first entry that is a no is silence, as an empty reply is", async () => {
    expect([...(await ask(`{"items":[${no(2)},${yes(1)}]}`)).read.yes!]).toEqual([]);
    expect([...(await ask(`{"items":[]}`)).read.yes!]).toEqual([]);
  });

  test("a complete lean reply with no no in it reads as is", async () => {
    expect([...(await ask(`{"items":[${yes(2)}]}`)).read.yes!]).toEqual(["mail:plain"]);
  });

  test("a stopped reply that is not the format still fails open", async () => {
    const { read, checker } = await ask(`The deposit "act":false`);
    expect(read.yes).toBeNull();
    expect(checker.stats.failures).toBe(1);
  });

  test("closeLean: braces and quotes inside strings do not end an entry", () => {
    const text = `{"items":[{"i":1,"on":"a {brace} and \\"quote\\"","hits":"x}","act":true},{"i":2,"on":"y","hits":"none",`;
    expect(JSON.parse(closeLean(text)).items).toEqual([{ i: 1, on: 'a {brace} and "quote"', hits: "x}", act: true }]);
    expect(closeLean(`{"items":[{"i":2,"on":"y",`)).toBe(`{"items":[]}`);
    expect(closeLean("not json")).toBe("not json");
  });
});
