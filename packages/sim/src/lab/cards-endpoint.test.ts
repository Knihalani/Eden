import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardKey, type CardBatch } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import { DiskCardMaker } from "./cards-disk";
import { endpointBase, endpointCardMaker, endpointFromArgs, EndpointModel, ENDPOINT_LABEL } from "./cards-endpoint";

/** A stub OpenAI-compatible server: a freeze card for item 0 of every batch and one request per item. */
const seen: { auth: string | null; body: Record<string, unknown> }[] = [];
let server: ReturnType<typeof Bun.serve>;
let status = 200;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      const body = (await req.json()) as { messages: { content: string }[] };
      seen.push({ auth: req.headers.get("authorization"), body });
      if (status !== 200) return new Response("overloaded", { status });
      const n = (body.messages[1]!.content.match(/<item i=/g) ?? []).length;
      const content = JSON.stringify({
        cards: [
          {
            i: 0,
            kind: "freeze",
            actions: ["deploy"],
            entities: ["production"],
            start: "2026-11-04",
            end: "2026-11-09",
            statement: "production change freeze 4-9 Nov",
          },
        ],
        requests: Array.from({ length: n }, (_, i) => ({ i, q: [`deploy item ${i}`] })),
      });
      return Response.json({
        model: "eden-cards",
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    },
  });
});
afterAll(() => server.stop(true));

const items: ContextItem[] = [
  { id: "a", ref: "a", sourceId: "mail", title: "Change freeze", text: "Do not deploy to production 4 to 9 November." },
  { id: "b", ref: "b", sourceId: "mail", title: "Lunch", text: "Sandwiches at noon?" },
];
const base = () => `http://localhost:${server.port}`;

describe("the lab card transport (cards-endpoint)", () => {
  test("the base URL gains /v1 once; other schemes are refused", () => {
    expect(endpointBase("https://x.modal.run")).toBe("https://x.modal.run/v1");
    expect(endpointBase("https://x.modal.run/v1/")).toBe("https://x.modal.run/v1");
    expect(() => endpointBase("file:///etc/passwd")).toThrow();
  });

  test("Eden's card prompt goes out as an OpenAI chat call; the reply is parsed by Eden at $0", async () => {
    seen.length = 0;
    const maker = endpointCardMaker({ baseUrl: base(), model: "eden-cards", apiKey: "k-test" });
    const got = await maker.make(items, "2026-10-27", AbortSignal.timeout(5_000), false, true);
    expect(got.costUsd).toBe(0);
    expect(got.cards[0]!.kind).toBe("freeze");
    expect(got.cards[1]!.kind).toBe("none");
    expect(got.requests).toEqual([["deploy item 0"], ["deploy item 1"]]);
    const sent = seen[0]!;
    expect(sent.auth).toBe("Bearer k-test");
    expect(sent.body.model).toBe("eden-cards");
    expect(sent.body.temperature).toBe(0);
    expect(sent.body.response_format).toEqual({ type: "json_object" });
    expect(sent.body.max_tokens).toBe(3_000);
  });

  test("a failed call throws its status, never the key", async () => {
    status = 503;
    try {
      const m = new EndpointModel({ baseUrl: base(), model: "eden-cards", apiKey: "secret-key" });
      const err = await m.chat({ messages: [], maxTokens: 10 }).catch((e: Error) => e);
      expect(String(err)).toContain("503");
      expect(String(err)).not.toContain("secret-key");
    } finally {
      status = 200;
    }
  });

  test("the key comes from EDEN_LAB_CARDS_KEY only", () => {
    expect(endpointFromArgs("https://x.modal.run", "", {})).toEqual({
      baseUrl: "https://x.modal.run/v1",
      model: "eden-cards",
    });
    expect(endpointFromArgs("https://x.modal.run", "m", { EDEN_LAB_CARDS_KEY: "k" }).apiKey).toBe("k");
    expect(endpointFromArgs("https://x.modal.run", "m", { EDEN_LAB_CARDS_TIMEOUT_MS: "900000" }).timeoutMs).toBe(900_000);
    expect(endpointFromArgs("https://x.modal.run", "m", { EDEN_LAB_CARDS_TIMEOUT_MS: "x" }).timeoutMs).toBeUndefined();
  });

  test("behind the disk cache: misses go to the endpoint once and are appended, so a rerun replays them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-cards-endpoint-"));
    try {
      const file = join(dir, "cards.jsonl");
      writeFileSync(file, "");
      seen.length = 0;
      const live = endpointCardMaker({ baseUrl: base(), model: "eden-cards" });
      const disk = new DiskCardMaker(file, live, { cardRequests: false });
      const first: CardBatch = await disk.make(items, "2026-10-27", AbortSignal.timeout(5_000), false, true);
      expect(first.cards[0]!.kind).toBe("freeze");
      expect(first.requests![1]).toEqual(["deploy item 1"]);
      expect(seen.length).toBe(1);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]!).h).toBe(cardKey(items[0]!));
      const again = new DiskCardMaker(file, live, { cardRequests: true });
      const second = await again.make(items, "2026-10-27", AbortSignal.timeout(5_000), false, true);
      expect(second.cards[0]!.kind).toBe("freeze");
      expect(seen.length).toBe(1);
      expect(ENDPOINT_LABEL).toContain("lab");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
