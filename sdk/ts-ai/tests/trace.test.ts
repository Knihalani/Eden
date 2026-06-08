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
});

function _flattenEvents(): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  for (const req of captured) {
    if (Array.isArray(req.body)) {
      events.push(...(req.body as TelemetryEvent[]));
    }
  }
  return events;
}
