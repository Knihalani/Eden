import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { searchSources } from "./fanout";
import { toItems } from "./mcp-source";
import type { Source } from "./source";
import { StaticSource } from "./static-source";

const scope = { tenantId: "t", userId: "u" };
const query = (text: string) => ({ scope, text, entities: [], limit: 5 });

describe("StaticSource", () => {
  test("ranks by term overlap and ids items by source", async () => {
    const s = new StaticSource("docs", "policies", [
      { ref: "a", title: "Travel policy", text: "Book flights through Navan" },
      { ref: "b", title: "Expense policy", text: "Receipts within 30 days, travel too" },
    ]);
    const items = await s.search(query("travel flights"));
    expect(items.map((i) => i.id)).toEqual(["docs:a", "docs:b"]);
  });
});

describe("toItems", () => {
  test("splits a JSON array result into items and keeps plain text whole", () => {
    const rows = JSON.stringify([{ id: "m1", subject: "Renewal", snippet: "Acme wants 3 years" }]);
    const items = toItems(
      "gmail",
      [
        { type: "text", text: rows },
        { type: "text", text: "plain note" },
      ],
      10,
    );
    expect(items[0]).toMatchObject({ id: "gmail:m1", title: "Renewal", text: "Acme wants 3 years" });
    expect(items[1]).toMatchObject({ id: "gmail:block-1", text: "plain note" });
  });
});

describe("searchSources", () => {
  const slow: Source = {
    id: "slow",
    kind: "test",
    description: "",
    search: () => new Promise<ContextItem[]>((r) => setTimeout(() => r([]), 1_000)),
  };
  const broken: Source = { id: "broken", kind: "test", description: "", search: async () => Promise.reject("x") };

  test("a slow or broken source reports why and never blocks the others", async () => {
    const ok = new StaticSource("ok", "", [{ ref: "1", title: "hello", text: "world" }]);
    const out = await searchSources([slow, broken, ok], query("hello"), { timeoutMs: 50 });
    expect(out.map((o) => [o.sourceId, o.status])).toEqual([
      ["slow", "timeout"],
      ["broken", "error"],
      ["ok", "ok"],
    ]);
    expect(out[2]!.items).toHaveLength(1);
  });
});
