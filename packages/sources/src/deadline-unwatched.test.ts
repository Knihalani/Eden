import { describe, expect, test } from "bun:test";
import type { ContextItem, Scope } from "@eden/protocol";
import { SourceFanout } from "./guarded";
import { McpSource, type McpSourceOptions } from "./mcp-source";
import type { ListPage, Source } from "./source";

const scope: Scope = { tenantId: "t", userId: "u" };

/** A source whose list and fetch take `ms` and do not watch the signal (a connector stuck in connect). */
function slow(ms: number): Source {
  const wait = () => new Promise((r) => setTimeout(r, ms));
  return {
    id: "mail",
    kind: "test",
    description: "",
    async search() {
      await wait();
      return [];
    },
    async list(): Promise<ListPage> {
      await wait();
      return { items: [], next: null };
    },
    async fetch(): Promise<ContextItem | null> {
      await wait();
      return null;
    },
  };
}

describe("audit A5: fan-out deadlines on list and fetch", () => {
  test("search returns at its timeout (control)", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    const t0 = performance.now();
    const [o] = await f.search([slow(800)], { scope, text: "x", entities: [], limit: 5 }, { timeoutMs: 50 });
    expect(o!.status).toBe("timeout");
    expect(performance.now() - t0).toBeLessThan(300);
  });

  test("list returns within its timeoutMs when the source ignores the signal", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    const t0 = performance.now();
    const page = await f.list(slow(800), scope, undefined, 10, { timeoutMs: 50 });
    const ms = performance.now() - t0;
    console.log("list:", page, Math.round(ms), "ms with timeoutMs 50");
    expect(ms).toBeLessThan(300);
  });

  test("fetchChecked returns within its timeoutMs when the source ignores the signal", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    const t0 = performance.now();
    const got = await f.fetchChecked(slow(800), scope, "r1", { timeoutMs: 50 });
    const ms = performance.now() - t0;
    console.log("fetchChecked:", got, Math.round(ms), "ms with timeoutMs 50");
    expect(ms).toBeLessThan(300);
  });

  test("McpSource.list honours its signal while connecting (a server that never answers initialize)", async () => {
    const transport = () =>
      ({
        async start() {},
        async close() {},
        async send() {}, // never answers
      }) as unknown as ReturnType<McpSourceOptions["transport"]>;
    const s = new McpSource({
      id: "mail",
      description: "",
      transport,
      searchTool: { name: "search", args: () => ({}) },
      listTool: { name: "list", args: () => ({}) },
    });
    const t0 = performance.now();
    const outcome = await Promise.race([
      s.list!(scope, undefined, 10, AbortSignal.timeout(100)).then(
        () => "resolved",
        (e) => `rejected: ${String(e).slice(0, 60)}`,
      ),
      new Promise((r) => setTimeout(() => r("still pending after 1.5 s"), 1_500)),
    ]);
    console.log("McpSource.list:", outcome, Math.round(performance.now() - t0), "ms with a 100 ms signal");
    expect(outcome).not.toBe("still pending after 1.5 s");
  });
});
