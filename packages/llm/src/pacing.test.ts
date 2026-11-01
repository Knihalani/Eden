import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenRouterModel } from "./openrouter";
import { Pacer, RequestCapReached, retryAfterMs } from "./pacing";
import { priceFor } from "./pricing";

/** A clock that only moves when the pacer sleeps, so the tests run in no real time. */
function fakeClock(start = 1_000_000) {
  const clock = { t: start, slept: [] as number[] };
  return {
    clock,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.slept.push(Math.round(ms));
      clock.t += ms;
    },
  };
}

/** A fetch that answers from a script of statuses (and headers), then 200 with `{}`. */
function scripted(script: { status: number; headers?: Record<string, string> }[]) {
  const calls: number[] = [];
  const fetch = (async () => {
    calls.push(calls.length);
    const next = script.shift();
    if (!next) return Response.json({ ok: true });
    return new Response("busy", { status: next.status, headers: next.headers ?? {} });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("Pacer", () => {
  test("keeps to the rate limit over a sliding minute", async () => {
    const c = fakeClock();
    const { fetch } = scripted([]);
    const pacer = new Pacer({ perMinute: 3, now: c.now, sleep: c.sleep, fetch });
    const t0 = c.clock.t;
    const starts: number[] = [];
    for (let i = 0; i < 7; i++) {
      await pacer.fetch("https://x/");
      starts.push(c.clock.t - t0);
    }
    // Three in the first minute, three in the second, the seventh in the third.
    expect(starts).toEqual([0, 0, 0, 60_000, 60_000, 60_000, 120_000]);
    expect(pacer.sent).toBe(7);
  });

  test("honours Retry-After on a 429 and holds every caller for it", async () => {
    const c = fakeClock();
    const { fetch, calls } = scripted([{ status: 429, headers: { "retry-after": "7" } }]);
    const pacer = new Pacer({ now: c.now, sleep: c.sleep, random: () => 0, fetch });
    const a = pacer.fetch("https://x/a");
    const res = await a;
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(c.clock.slept[0]).toBe(7_000);
    expect(pacer.summary()).toMatchObject({ sent: 2, retried: 1, statuses: { 429: 1 } });
  });

  test("a 429 holds the pacer itself: no request starts before its delay passes", async () => {
    const c = fakeClock();
    const { fetch } = scripted([{ status: 429, headers: { "retry-after-ms": "5000" } }]);
    // The retry's own backoff returns at once (as if woken early); the pacer's hold must still gate the next start.
    let first = true;
    const sleep = async (ms: number) => {
      c.clock.slept.push(Math.round(ms));
      if (first) first = false;
      else c.clock.t += ms;
    };
    const t0 = c.clock.t;
    const pacer = new Pacer({ now: c.now, sleep, random: () => 0, fetch });
    expect((await pacer.fetch("https://x/a")).status).toBe(200);
    expect(c.clock.t - t0).toBe(5_000);
  });

  test("backs off with jitter on 503 and network failures, and gives up after its retries", async () => {
    const c = fakeClock();
    const failing = (async () => {
      throw new TypeError("connection reset");
    }) as unknown as typeof fetch;
    const pacer = new Pacer({
      retries: 2,
      baseDelayMs: 1_000,
      now: c.now,
      sleep: c.sleep,
      random: () => 1,
      fetch: failing,
    });
    await expect(pacer.fetch("https://x/")).rejects.toThrow("connection reset");
    expect(pacer.sent).toBe(3);
    expect(c.clock.slept).toEqual([1_000, 2_000]);

    const c2 = fakeClock();
    const { fetch } = scripted([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const p2 = new Pacer({ retries: 2, baseDelayMs: 1_000, now: c2.now, sleep: c2.sleep, random: () => 0, fetch });
    const res = await p2.fetch("https://x/");
    // Out of retries: the last response goes back as it came, for the caller to report.
    expect(res.status).toBe(503);
    expect(c2.clock.slept).toEqual([500, 1_000]);
  });

  test("does not wait out a delay longer than its maximum (a daily limit)", async () => {
    const c = fakeClock();
    const { fetch, calls } = scripted([{ status: 429, headers: { "retry-after": "3600" } }]);
    const pacer = new Pacer({ maxDelayMs: 65_000, now: c.now, sleep: c.sleep, fetch });
    const res = await pacer.fetch("https://x/");
    expect(res.status).toBe(429);
    expect(calls.length).toBe(1);
    expect(c.clock.slept).toEqual([]);
  });

  test("passes other statuses straight through", async () => {
    const { fetch, calls } = scripted([{ status: 400 }]);
    const pacer = new Pacer({ fetch });
    expect((await pacer.fetch("https://x/")).status).toBe(400);
    expect(calls.length).toBe(1);
  });

  test("counts every attempt against the cap and refuses once it is reached", async () => {
    const c = fakeClock();
    const { fetch, calls } = scripted([{ status: 429, headers: { "retry-after": "1" } }]);
    const pacer = new Pacer({ maxRequests: 3, now: c.now, sleep: c.sleep, fetch });
    await pacer.fetch("https://x/a"); // two attempts
    await pacer.fetch("https://x/b"); // the third
    expect(pacer.exhausted).toBe(true);
    expect(pacer.remaining).toBe(0);
    await expect(pacer.fetch("https://x/c")).rejects.toBeInstanceOf(RequestCapReached);
    expect(calls.length).toBe(3);
    expect(pacer.summary()).toMatchObject({ sent: 3, refused: 1, cap: 3 });
  });

  test("a cap reached mid-retry stops the retry before it is sent", async () => {
    const c = fakeClock();
    const { fetch, calls } = scripted([{ status: 503 }, { status: 503 }]);
    const pacer = new Pacer({ maxRequests: 1, now: c.now, sleep: c.sleep, random: () => 0, fetch });
    await expect(pacer.fetch("https://x/")).rejects.toBeInstanceOf(RequestCapReached);
    expect(calls.length).toBe(1);
  });

  test("an aborted request stops waiting", async () => {
    const pacer = new Pacer({ perMinute: 1, fetch: scripted([]).fetch });
    await pacer.fetch("https://x/");
    const ctl = new AbortController();
    const pending = pacer.fetch("https://x/", { signal: ctl.signal });
    ctl.abort();
    await expect(pending).rejects.toThrow();
    expect(pacer.sent).toBe(1);
  });

  test("reads Retry-After as seconds, an HTTP date, ms, or a 429's epoch reset", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    const r = (h: Record<string, string>, status = 429) => new Response(null, { status, headers: h });
    expect(retryAfterMs(r({ "retry-after": "2" }), now)).toBe(2_000);
    expect(retryAfterMs(r({ "retry-after": "Sun, 01 Nov 2026 00:00:30 GMT" }), now)).toBe(30_000);
    expect(retryAfterMs(r({ "retry-after-ms": "250" }), now)).toBe(250);
    expect(retryAfterMs(r({ "x-ratelimit-reset": String(now + 9_000) }), now)).toBe(9_000);
    expect(retryAfterMs(r({ "x-ratelimit-reset": String(now + 9_000) }, 503), now)).toBeNull();
    expect(retryAfterMs(r({}), now)).toBeNull();
  });
});

describe("free models and logging (lab only)", () => {
  const reply = (cost?: number) =>
    (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 100, completion_tokens: 5, ...(cost === undefined ? {} : { cost }) },
      });
    }) as unknown as typeof fetch;
  let sent: any[] = [];

  test("allowLogging lifts data_collection and zdr; the default keeps both", async () => {
    sent = [];
    const msg = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 5 };
    await new OpenRouterModel({ apiKey: "k", model: "m:free", fetch: reply(0), allowLogging: true }).chat(msg);
    await new OpenRouterModel({ apiKey: "k", model: "m:free", fetch: reply(0) }).chat(msg);
    expect(sent[0].provider).toMatchObject({ data_collection: "allow", zdr: false });
    expect(sent[1].provider).toMatchObject({ data_collection: "deny", zdr: true });
  });

  test("fromEnv never allows logging, whatever the environment says", async () => {
    sent = [];
    const env = { OPENROUTER_API_KEY: "k", EDEN_ALLOW_LOGGING: "1", EDEN_MODEL_ZDR: "off", ALLOW_LOGGING: "true" };
    const model = OpenRouterModel.fromEnv(env)!;
    (model as unknown as { options: { fetch: typeof fetch } }).options.fetch = reply(0);
    await model.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 5 });
    expect(sent[0].provider.data_collection).toBe("deny");
  });

  test("nothing in the product sets allowLogging", () => {
    const root = join(import.meta.dir, "..", "..");
    const offenders: string[] = [];
    for (const pkg of ["server", "engine", "client", "sources", "protocol", "graph", "redact"]) {
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (p.endsWith(".ts") && readFileSync(p, "utf8").includes("allowLogging")) offenders.push(p);
        }
      };
      walk(join(root, pkg, "src"));
    }
    expect(offenders).toEqual([]);
  });

  test("a free model costs nothing: its reported $0 stands and its budget estimate is $0", async () => {
    expect(priceFor("nvidia/nemotron-3.5-super-vl:free", {})).toEqual({ input: 0, output: 0 });
    expect(priceFor("z-ai/glm-5.3-flash", {}).input).toBeGreaterThan(0);
    const out = await new OpenRouterModel({ apiKey: "k", model: "m:free", fetch: reply(0), allowLogging: true }).chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 5,
    });
    expect(out.costUsd).toBe(0);
    const unreported = await new OpenRouterModel({ apiKey: "k", model: "m:free", fetch: reply() }).chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 5,
    });
    expect(unreported.costUsd).toBe(0);
  });
});
