import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Vocab } from "@eden/primitives";
import { z } from "zod";
import { buildWorld } from "../world";
import { eventTimes, mailParts, numbersIn } from "./connectors";
import { keysIn, labCases, runConnector, tap, variantQueries, worldKey, type LabConnector } from "./lab";

// The lab itself needs Docker (lab-cli.ts); these cover the parts that decide its numbers.
describe("connector lab", () => {
  const world = buildWorld({ seed: 1_000 });

  test("every world item's key is found back in a result, and nothing else is", () => {
    const keys = world.items.map(worldKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(keysIn(`{"path":"x/${k}.md"} and [${k}]`)).toEqual([k]);
    expect(keysIn("gmail mail-3, crm-deal, calendar-event-x, notgmail-mail-3")).toEqual([]);
  });

  test("cases have text and needed facts that the world states", () => {
    const cases = labCases(world, 1_007, 20);
    expect(cases.length).toBeGreaterThan(20);
    expect(new Set(cases.map((c) => c.text)).size).toBe(cases.length);
    for (const c of cases) {
      expect(c.text.length).toBeGreaterThan(0);
      for (const f of c.must) expect(world.facts.has(f)).toBe(true);
    }
  });

  test("variants: terms is the cue, entity variants need entities, each-entity is one query per entity", () => {
    const vocab = new Vocab();
    const df = new Map([
      ["prep", 50],
      ["call", 40],
    ]);
    const text = "Prep me for the Globex call with Sam Ortiz";
    expect(variantQueries("question", text, df, vocab)).toEqual([text]);
    expect(variantQueries("terms", text, df, vocab)).toEqual(["prep globex call sam ortiz"]);
    expect(variantQueries("entities", text, df, vocab)).toEqual(["Globex Sam Ortiz"]);
    expect(variantQueries("each-entity", text, df, vocab)).toEqual(["Globex", "Sam Ortiz"]);
    expect(variantQueries("entity+term", text, df, vocab)).toEqual(["Globex call"]);
    expect(variantQueries("entities", "what time is it", df, vocab)).toEqual([]);
  });

  test("event times come from the When: line", () => {
    const e = world.items.find((i) => i.kind === "event" && i.text.includes("When:"))!;
    const { start, end } = eventTimes(e);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
    expect(e.text).toContain(`${start.getUTCDate()} `);
  });

  test("tap reports raw tool results and their error flag, and passes every message on", async () => {
    const inner: Transport = { start: async () => {}, send: async () => {}, close: async () => {} };
    const seen: [string, boolean][] = [];
    const passed: JSONRPCMessage[] = [];
    const t = tap(inner, (text, isError) => seen.push([text, isError]));
    t.onmessage = (m) => passed.push(m);
    const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "drive-doc-4" }] } };
    const bad = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "boom" }], isError: true } };
    const note = { jsonrpc: "2.0", method: "notifications/progress" };
    for (const m of [ok, bad, note]) inner.onmessage!(m as JSONRPCMessage);
    expect(seen.map(([, e]) => e)).toEqual([false, true]);
    expect(keysIn(seen[0]![0])).toEqual(["drive-doc-4"]);
    expect(passed.length).toBe(3);
  });

  test("numbersIn reads ids from JSON text blocks, only on objects with the required keys", () => {
    const issues = [
      { number: 3, title: "a", repository: { id: 9, number: 99 } },
      { number: 5, title: "b" },
    ];
    const raw = JSON.stringify([
      { type: "text", text: JSON.stringify(issues) },
      { type: "text", text: "not json" },
    ]);
    expect(numbersIn(raw, "number", ["title"])).toEqual([3, 5]);
    const mail = JSON.stringify([{ type: "text", text: JSON.stringify({ messages: [{ uid: 1 }, { uid: 7 }] }) }]);
    expect(numbersIn(mail, "uid")).toEqual([1, 7]);
    expect(numbersIn("garbage", "uid")).toEqual([]);
  });

  test("mail items split into their header lines and body", () => {
    const m = world.items.find((i) => i.kind === "mail" && i.text.startsWith("From:"))!;
    const { headers, body } = mailParts(m);
    expect(headers.From).toBeTruthy();
    expect(headers.Date).toBeTruthy();
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("From: ");
  });

  /**
   * A whole-string-substring connector in process: "Jamie Fox" finds the event the cases need, "dinner" finds twelve
   * noise items, "boom" is a tool error. Every number runConnector reports is then known in advance.
   */
  function fakeConnector(log: string[], failSetup = false): LabConnector {
    const event = world.items.find((i) => i.facts.includes("meet-p-jamie-fox:event"))!;
    const noise = world.items
      .filter((i) => i.facts.length === 0)
      .slice(0, 12)
      .map(worldKey);
    return {
      name: "fake",
      semantics: "whole query as one substring",
      accepts: () => true,
      async setup() {
        log.push("setup");
        if (failSetup) throw new Error("backend did not start");
      },
      transport() {
        const server = new McpServer({ name: "fake", version: "1" });
        server.registerTool(
          "search",
          { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
          async ({ query }) => {
            if (query.includes("boom")) return { content: [{ type: "text", text: "boom" }], isError: true };
            const keys = query.includes("Jamie Fox") ? [worldKey(event)] : query.includes("dinner") ? noise : [];
            return { content: [{ type: "text", text: JSON.stringify(keys.map((id) => ({ id }))) }] };
          },
        );
        const [client, serverSide] = InMemoryTransport.createLinkedPair();
        void server.connect(serverSide);
        return client;
      },
      searchTool: { name: "search", args: (text) => ({ query: text }) },
      async teardown() {
        log.push("teardown");
      },
    };
  }

  test("runConnector: reach, reachAll, empty, result cap and errors on a connector with known answers", async () => {
    const must = ["meet-p-jamie-fox:event"];
    const cases = [
      { text: "When is my dinner with Jamie Fox?", must, ok: [] },
      { text: "what's for dinner tonight", must, ok: [] },
      { text: "boom", must, ok: [] },
      { text: "Something about Jamie", must: ["no-such-fact"], ok: [] }, // not answerable here: not counted
    ];
    const log: string[] = [];
    const r = await runConnector(fakeConnector(log), world, cases, { limit: 10 });
    expect(log).toEqual(["setup", "teardown"]);
    expect(r.cases).toBe(3);
    const q = r.variants.question!;
    // Case 1 hits; case 2 returns 12 noise items, capped at 10; case 3 is a tool error.
    expect([q.cases, q.calls, q.hits, q.reach, q.reachAll, q.errors]).toEqual([3, 3, 1, 0.333, 0.333, 1]);
    expect([q.empty, q.returned, q.returnedRaw]).toEqual([0.333, 3.7, 4.3]);
    expect(q.relevantShare).toBe(0.091); // 1 of 11 kept items holds the fact
    // Terms are lower-cased ("dinner jamie fox"), so the substring "Jamie Fox" is never sent.
    expect(r.variants.terms!.hits).toBe(0);
    const e = r.variants.entities!; // only case 1 has an entity
    expect([e.cases, e.hits, e.reach, e.reachAll]).toEqual([1, 1, 1, 0.333]);
    expect(r.refFallback).toBe(0); // Rows with an `id` keep it in toItems.
    expect(r.idCollisions).toBe(0);
    expect(r.idSplits).toBe(0);
  });

  test("runConnector tears the connector down when setup fails", async () => {
    const log: string[] = [];
    const cases = [{ text: "When is my dinner with Jamie Fox?", must: ["meet-p-jamie-fox:event"], ok: [] }];
    await expect(runConnector(fakeConnector(log, true), world, cases)).rejects.toThrow("backend did not start");
    expect(log).toEqual(["setup", "teardown"]);
  });
});
