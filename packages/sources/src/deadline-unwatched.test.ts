import { describe, expect, test } from "bun:test";
import type { ContextItem, Scope } from "@eden/protocol";
import { SourceFanout } from "./guarded";
import { McpSource, type McpSourceOptions } from "./mcp-source";
import type { ListPage, Source } from "./source";

const scope: Scope = { tenantId: "t", userId: "u" };

/**
 * A source whose calls do not watch the signal (a connector stuck in connect) and answer only when `release` is
 * called, or after `HOLD_MS`. Whether a call came back at its own timeout is read from `out` at its return (the source
 * still holding the call), not from a wall-clock bound: one at 300 ms read 444 ms in a loaded gate (D1965).
 */
const HOLD_MS = 3_000;
function held(): Source & { out: number; release(): void } {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const timer = setTimeout(() => release(), HOLD_MS);
  const src = {
    out: 0,
    release: () => {
      clearTimeout(timer);
      release();
    },
  };
  const wait = async () => {
    src.out++;
    await gate;
    src.out--;
  };
  return Object.assign(src, {
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
  });
}

describe("audit A5: fan-out deadlines on list and fetch", () => {
  test("search returns at its timeout (control)", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    const src = held();
    const [o] = await f.search([src], { scope, text: "x", entities: [], limit: 5 }, { timeoutMs: 50 });
    // Back while the source still holds the call: at the timeout, not at the source's answer.
    expect(src.out).toBe(1);
    src.release();
    expect(o!.status).toBe("timeout");
  });

  // `list` is not raced (audit A5): the extra await moved the funnel's card batching (504 calls to 546); a listing that
  // ignores its signal is bounded where a lookup waits for it (partner.ts, `freshen-deadline.test.ts`), and McpSource,
  // the one real case, gives up its connect at the signal (below).
  test("fetchChecked returns within its timeoutMs when the source ignores the signal", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    const src = held();
    const got = await f.fetchChecked(src, scope, "r1", { timeoutMs: 50 });
    expect(src.out).toBe(1);
    src.release();
    expect(got).toMatchObject({ status: "failed", why: "timeout" });
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
    expect(outcome).not.toBe("still pending after 1.5 s");
  });
});
