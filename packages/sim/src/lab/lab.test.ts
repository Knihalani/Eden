import { describe, expect, test } from "bun:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Vocab } from "@eden/primitives";
import { buildWorld } from "../world";
import { eventTimes, mailParts, numbersIn } from "./connectors";
import { keysIn, labCases, tap, variantQueries, worldKey } from "./lab";

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
});
