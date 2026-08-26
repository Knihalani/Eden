import { describe, expect, test } from "bun:test";
import {
  createWitnessTable,
  islandMemoKey,
  openaiIsland,
  withWitnessMemo,
} from "./island";

/** Fake OpenAI fetch. Latency is optional; default 0 — tests assert memoization, not wall time. */
function fakeFetch(calls: { n: number }, latencyMs = 0): typeof fetch {
  const fn = async (_url: unknown, init: RequestInit) => {
    calls.n++;
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    const body = JSON.parse(String(init.body));
    const user = JSON.parse(body.messages[1].content);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ owner: user.repos?.[0]?.split("/")[0] ?? "?" }) } }] }),
      { status: 200 },
    );
  };
  return fn as typeof fetch;
}

describe("deterministic-first islands", () => {
  test("identical input twice is served from witnesses forever after; unseen input falls back", async () => {
    const calls = { n: 0 };
    const base = openaiIsland({ fetch: fakeFetch(calls) });
    const fast = withWitnessMemo(base);
    const req = { system: "s", input: { repos: ["acme/app"] }, outputSchema: {} } as never;

    const r1 = await fast(req); // miss → live call
    const r2 = await fast(req); // seen=2 now
    const before = calls.n;
    const r3 = await fast(req); // served from memo

    expect(r1).toEqual({ owner: "acme" });
    expect(r2).toEqual({ owner: "acme" });
    expect(r3).toEqual({ owner: "acme" });
    expect(calls.n - before).toBe(0);

    await fast({ system: "s", input: { repos: ["other/x"] }, outputSchema: {} } as never);
    expect(calls.n).toBeGreaterThan(before); // fallback still reaches the model
  });

  test("disagreeing outputs reset the evidence count instead of poisoning the table", () => {
    const t = createWitnessTable();
    const k = islandMemoKey({ system: "s", input: 1, outputSchema: {} });
    t.observe(k, { a: 1 });
    expect(t.lookup(k)).toBeUndefined();
    t.observe(k, { a: 1 });
    expect(t.lookup(k)).toEqual({ a: 1 });
    t.observe(k, { a: 2 }); // contradiction
    expect(t.lookup(k)).toBeUndefined(); // evidence reset, not stale answer
    t.observe(k, { a: 2 });
    expect(t.lookup(k)).toEqual({ a: 2 });
  });

  test("different schemas/inputs never share an entry", async () => {
    const calls = { n: 0 };
    const base = openaiIsland({ fetch: fakeFetch(calls) });
    const fast = withWitnessMemo(base);
    await fast({ system: "s", input: { repos: ["o/r"] }, outputSchema: {} } as never);
    await fast({ system: "s", input: { repos: ["o/r"] }, outputSchema: {} } as never);
    const before = calls.n;
    await fast({ system: "s2", input: { repos: ["o/r"] }, outputSchema: {} } as never);
    expect(calls.n).toBe(before + 1);
  });
});
