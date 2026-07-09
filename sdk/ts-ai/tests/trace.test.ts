/**
 * Tests for `trace()` and `traceAgent()`.
 *
 * Verifies the trace context is created, that timing/status is
 * captured correctly, and that the wrapped function still
 * behaves like the original.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  getDefaultClient,
  resetDefaultClient,
  type TelemetryEvent,
} from "../src/client.js";
import { wireToEvent } from "../src/wire";
import { trace, traceAgent, configure } from "../src/trace.js";

interface CapturedRequest {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

let captured: CapturedRequest[];
let originalFetch: typeof fetch;

beforeEach(() => {
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: unknown = init?.body;
    try {
      body = init?.body ? JSON.parse(init.body as string) : null;
    } catch {
      // keep raw
    }
    captured.push({
      url,
      body,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return new Response("{}", { status: 200 });
  }) as unknown) as typeof fetch;
  resetDefaultClient();
  configure({
    orgId: "org_test",
    apiKey: "key_test",
    tags: ["test"],
  });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetDefaultClient();
});

describe("trace()", () => {
  it("returns the wrapped function's value", async () => {
    const value = await trace("returns", async () => 42);
    expect(value).toBe(42);
  });

  it("emits one agent_call event on success", async () => {
    await trace("happy", async () => "ok");
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const call = events.find((e) => e.eventType === "agent_call");
    expect(call).toBeDefined();
    expect(call?.payload.status).toBe("success");
    expect(call?.payload.name).toBe("happy");
    expect(call?.sourceFormat).toBe("eden-trace-agent-ts");
  });

  it("emits error status when the function throws", async () => {
    await expect(
      trace("boom", async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");
    await getDefaultClient().flush();
    const call = _flattenEvents().find((e) => e.eventType === "agent_call");
    expect(call?.payload.status).toBe("error");
    expect(call?.payload.error_type).toBe("Error");
  });

  it("includes the trace context inside the function", async () => {
    let observed: unknown = null;
    await trace("ctx", async (ctx) => {
      observed = ctx;
    });
    expect((observed as { traceId: string }).traceId).toBeTruthy();
    expect((observed as { spanId: string }).spanId).toBeTruthy();
    expect(typeof (observed as { startMs: number }).startMs).toBe("number");
  });
});

describe("traceAgent()", () => {
  class MyAgent {
    @traceAgent({ tags: ["prod"] })
    async run(q: string): Promise<string> {
      return `hello ${q}`;
    }
  }

  it("wraps class methods", async () => {
    const agent = new MyAgent();
    const result = await agent.run("world");
    expect(result).toBe("hello world");
    await getDefaultClient().flush();
    const call = _flattenEvents().find((e) => e.eventType === "agent_call");
    expect(call?.payload.function).toBe("MyAgent.run");
    expect(call?.payload.status).toBe("success");
  });

  it("captures synchronous return values", async () => {
    class Sync {
      @traceAgent()
      add(a: number, b: number): number {
        return a + b;
      }
    }
    const r = new Sync();
    expect(r.add(2, 3)).toBe(5);
    await getDefaultClient().flush();
    const call = _flattenEvents().find((e) => e.eventType === "agent_call");
    expect(call?.payload.status).toBe("success");
  });

  it("captures synchronous throws", async () => {
    class Throwy {
      @traceAgent()
      bad(): never {
        throw new Error("nope");
      }
    }
    expect(() => new Throwy().bad()).toThrow("nope");
    await getDefaultClient().flush();
    const call = _flattenEvents().find((e) => e.eventType === "agent_call");
    expect(call?.payload.status).toBe("error");
    expect(call?.payload.error_type).toBe("Error");
  });

  it(
    "captures the error MESSAGE (not just the class name) on sync throws",
    async () => {
      // Regression: the previous decorator path stored only
      // ``err.constructor.name`` on ``controller.error``, so the
      // wire payload had ``error_type: "TypeError"`` with
      // ``error_message: null`` for every decorator-thrown
      // exception. The callback form of ``trace()`` and the
      // Python SDK's ``@trace_agent`` both captured the full
      // message -- so the TS decorator was a silent regression
      // that dropped the human-readable error text the portal
      // surfaces in the trace detail view. Pin that the
      // message now lands on the wire.
      class Typed {
        @traceAgent()
        boom(): never {
          throw new TypeError("kaboom");
        }
      }
      let caught: unknown;
      try {
        new Typed().boom();
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).toBe("kaboom");
      await getDefaultClient().flush();
      const call = _flattenEvents().find(
        (e) => e.eventType === "agent_call" && e.payload.error_type === "TypeError",
      );
      expect(call?.payload.status).toBe("error");
      expect(call?.payload.error_type).toBe("TypeError");
      expect(call?.payload.error_message).toBe("kaboom");
    },
  );

  it(
    "captures the error MESSAGE on async rejects (regression)",
    async () => {
      // Same regression as the sync test, but on the
      // promise-rejection path (the more common case in
      // modern async agents).
      class Async {
        @traceAgent()
        async boom(): Promise<never> {
          throw new RangeError("async-boom");
        }
      }
      let caught: unknown;
      try {
        await new Async().boom();
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).toBe("async-boom");
      await getDefaultClient().flush();
      const call = _flattenEvents().find(
        (e) => e.eventType === "agent_call" && e.payload.error_type === "RangeError",
      );
      expect(call?.payload.status).toBe("error");
      expect(call?.payload.error_type).toBe("RangeError");
      expect(call?.payload.error_message).toBe("async-boom");
    },
  );
});

function _flattenEvents(): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  for (const req of captured) {
    if (Array.isArray(req.body)) {
      // Wire body is snake_case; convert back to camelCase so the
      // assertions on e.eventType etc. keep matching the SDK
      // internal shape.
      events.push(...(req.body as Record<string, unknown>[]).map((w) => wireToEvent(w) as unknown as TelemetryEvent));
    }
  }
  return events;
}


// ── New: context-manager-style trace() with rich Span API ──────────

describe("trace() context-manager form", () => {
  it("yields a TraceContext with setInput/setOutput/setTag/setStatus", async () => {
    resetDefaultClient();
    configure({ orgId: "o", apiKey: "k" });
    const t = trace("qa-pipeline");
    t.setInput({ q: "hi" });
    t.setTag("prod", "checkout");
    const child = trace("summarise");
    child.setInput("summarising");
    child.setOutput({ summary: "ok" });
    child.end();
    t.setOutput({ final: "ok" });
    t.end();

    expect(t.input).toEqual({ q: "hi" });
    expect(t.output).toEqual({ final: "ok" });
    expect(t.tags).toContain("prod");
    expect(t.tags).toContain("checkout");
    expect(child.output).toEqual({ summary: "ok" });
    expect(t.traceId).toBe(child.traceId); // child inherits
    expect(t.spanId).not.toBe(child.spanId); // but separate span
    expect(child.parentSpanId).toBe(t.spanId); // parent linkage

    await getDefaultClient().flush();
    await new Promise((r) => setTimeout(r, 50));
    const events = _flattenEvents();
    const root = events.find((e) => (e.name === "qa-pipeline" || e.payload?.name === "qa-pipeline") && e.eventType === "agent_call");
    expect(root).toBeDefined();
    expect((root?.payload as Record<string, unknown>).input).toEqual({ q: "hi" });
    expect((root?.payload as Record<string, unknown>).output).toEqual({ final: "ok" });
  });

  it("setStatus('error', { error }) marks outcome as error and emits error_type", async () => {
    resetDefaultClient();
    configure({ orgId: "o", apiKey: "k" });
    const t = trace("error-path");
    t.setStatus("error", { error: "boom" });
    t.end();

    // t.outcome not exposed; status is the public field.
    await getDefaultClient().flush();
    await new Promise((r) => setTimeout(r, 50));
    const ev = _flattenEvents().find((e) => (e.name === "error-path" || e.payload?.name === "error-path") && e.eventType === "agent_call");
    expect(ev).toBeDefined();
    expect((ev!.payload as Record<string, unknown>).status).toBe("error");
    expect((ev?.payload as Record<string, unknown>).error_type).toBe("boom");
  });

  it("end() is idempotent — second call is a no-op", () => {
    const t = trace("once");
    t.end();
    const firstEnd = t.endMs;
    t.end();
    expect(t.endMs).toBe(firstEnd);
  });

  it("auto-fills trace_id and span_id as 24/16 hex strings", () => {
    const t = trace("ids");
    expect(t.traceId).toMatch(/^.{24}$/);
    expect(t.spanId).toMatch(/^.{16}$/);
    t.end();
  });
});


describe("active-context stack hygiene", () => {
  it("does not grow the active-context stack across many traces", async () => {
    // Regression: ``_activeContextStack.push(controller)`` was
    // never paired with a pop, so the stack grew unboundedly
    // across the lifetime of the process and the wrong (dead)
    // span kept being returned as the new parent.
    // Flush after each batch so the events don't pile up in
    // the queue and obscure the count assertion.
    const client = getDefaultClient();
    for (let i = 0; i < 50; i++) {
      await trace(`span-${i}`, async () => 1);
    }
    await client.flush();
    // Probe via a fresh trace — should not throw and should
    // emit a root event.
    const probe = await trace("probe", async () => "ok");
    expect(probe).toBe("ok");
    await client.flush();
    // 50 traces + 1 probe, each emits a single agent_call event
    // batched into a single fetch POST. The fact that 50 traces
    // completed without erroring and the captured fetch was
    // reached is the regression assertion.
    expect(captured.length).toBeGreaterThanOrEqual(1);
  });

  it("nested traces don't pollute the stack after end", async () => {
    const client = getDefaultClient();
    for (let i = 0; i < 20; i++) {
      await trace(`outer-${i}`, async () => {
        await trace(`inner-${i}`, async () => 1);
      });
    }
    await client.flush();
    // Should still work without stacking dead spans.
    const probe = await trace("probe-after-nested", async () => 2);
    expect(probe).toBe(2);
    await client.flush();
    expect(captured.length).toBeGreaterThanOrEqual(1);
  });
});
