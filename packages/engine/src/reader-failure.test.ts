import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, type ChatRequest, type ChatResponse, type Model } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, ModelReaderMaker, type ReaderInput } from "./reader";

/**
 * A reader whose model fails must stay invisible to the agent (fail open, D41) but visible to the operator: the
 * `onFailure` hook is how the server logs it (build.ts). Seen live: every call to the shipped role model returned
 * OpenRouter's 403 "violation of provider Terms Of Service" for one account, and nothing said so.
 */

const NOW = Date.parse("2026-10-27T09:00:00Z");
const scope = { tenantId: "t", userId: "u1" };
const REFUSAL =
  'openrouter 403: {"error":{"message":"The request is prohibited due to a violation of provider Terms"}}';

/** A model that throws what OpenRouterModel throws on a non-2xx reply; counts its calls. */
class RefusingModel implements Model {
  readonly id = "anthropic/claude-haiku-5.5";
  calls = 0;
  constructor(private readonly message = REFUSAL) {}
  async chat(_request: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    throw new Error(this.message);
  }
}

/** A model that answers with nothing a reader can parse. */
class GarbledModel implements Model {
  readonly id = "garbled";
  async chat(): Promise<ChatResponse> {
    return {
      text: "not json",
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 },
      costUsd: 0,
      model: this.id,
      latencyMs: 0,
      truncated: false,
    };
  }
}

const input = (request = "Pay the Harlow invoice"): ReaderInput => ({
  request,
  today: "2026-10-27",
  items: [
    {
      id: "mail:a",
      source: "mail",
      title: "Harlow invoice",
      date: "2026-10-26",
      from: "",
      text: "Harlow venue deposit invoice, due Friday",
      hash: "h1",
    },
  ],
});

const readerWith = (model: Model, onFailure?: (error: unknown) => void) =>
  new AskReader({ maker: new ModelReaderMaker(model), budget: new Budget(), now: () => NOW, onFailure });

describe("reader failures are told to the embedder and still fail open", () => {
  test("a provider refusal: null verdict, never a throw, and the hook gets the provider's error", async () => {
    const seen: unknown[] = [];
    const reader = readerWith(new RefusingModel(), (e) => seen.push(e));
    const got = await reader.read(scope, "s1", input(), new AbortController().signal);
    expect(got).toEqual({ verdict: null, costUsd: 0, called: true, overBudget: false });
    expect(reader.stats.failures).toBe(1);
    expect(seen.length).toBe(1);
    expect((seen[0] as Error).message).toBe(REFUSAL);
  });

  test("an unreadable reply is a failure too; a good reply and a budget refusal are not", async () => {
    const seen: unknown[] = [];
    const garbled = readerWith(new GarbledModel(), (e) => seen.push(e));
    expect(await garbled.verdictFor(scope, "s1", input(), new AbortController().signal)).toBeNull();
    expect(seen.length).toBe(1);
    expect((seen[0] as Error).message).toContain("unreadable");
    const broke = new AskReader({
      maker: new ModelReaderMaker(new RefusingModel()),
      budget: new Budget({ callsPerSession: 0, usdPerSession: 1, usdPerUserDay: 1 }),
      now: () => NOW,
      onFailure: (e) => seen.push(e),
    });
    expect(await broke.verdictFor(scope, "s1", input(), new AbortController().signal)).toBeNull();
    expect(broke.stats.overBudget).toBe(1);
    expect(seen.length).toBe(1);
  });

  test("a call its caller aborted, or whose user was forgotten, is not a failure", async () => {
    const seen: unknown[] = [];
    // A model that waits for the abort, then throws as fetch does.
    const hanging: Model = {
      id: "hang",
      chat: (req) =>
        new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    };
    const reader = readerWith(hanging, (e) => seen.push(e));
    const caller = new AbortController();
    const first = reader.read(scope, "s1", input(), caller.signal);
    caller.abort();
    expect((await first).verdict).toBeNull();
    const second = reader.read(scope, "s1", input("Pay the other invoice"), new AbortController().signal);
    reader.forget(scope);
    expect((await second).verdict).toBeNull();
    expect(reader.stats.failures).toBe(2);
    expect(seen).toEqual([]);
  });

  test("a hook that throws changes nothing: the read still fails open", async () => {
    const reader = readerWith(new RefusingModel(), () => {
      throw new Error("logger down");
    });
    expect(await reader.verdictFor(scope, "s1", input(), new AbortController().signal)).toBeNull();
  });

  test("through the partner: the ask answers from the rules while the reader's model refuses every call", async () => {
    const items: ContextItem[] = [
      {
        id: "mail:inv",
        sourceId: "mail",
        ref: "inv",
        title: "Harlow invoice",
        text: "Harlow venue deposit invoice, due Friday",
        updatedAt: NOW - 3_600_000,
      },
    ];
    const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => items };
    const run = async (model: Model | null) => {
      const seen: unknown[] = [];
      const reader = model ? readerWith(model, (e) => seen.push(e)) : undefined;
      const partner = new ContextPartner({
        sources: async () => [source],
        sourceMap: new SourceMap(),
        cache: new ItemCache(),
        budget: new Budget(),
        model: null,
        now: () => NOW,
        config: { ...CORE_CONFIG, askReader: !!reader, askReaderWaitMs: 500 },
        ...(reader ? { reader } : {}),
      });
      const a = await partner.ask({ ...scope, sessionId: "s1", question: "Pay the Harlow venue deposit invoice" });
      return { answer: a.answer, ids: a.citations.map((c) => c.itemId), seen };
    };
    const base = await run(null);
    const model = new RefusingModel();
    const refused = await run(model);
    expect(base.ids).toContain("mail:inv");
    expect({ answer: refused.answer, ids: refused.ids }).toEqual({ answer: base.answer, ids: base.ids });
    expect(model.calls).toBe(1);
    expect(refused.seen.length).toBe(1);
  });
});
