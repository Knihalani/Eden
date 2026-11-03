import { describe, expect, test } from "bun:test";
import { isId, type ActionCheck, type Injection } from "@eden/protocol";
import { DEFAULT_WAIT_MS, EdenClient, edenId } from "./client";
import { heldResult, withContext } from "./messages";

const inj = (text: string) => ({ id: "inj_1", text }) as Injection;

describe("EdenClient", () => {
  test("fails open: a dead server means no context, not an exception", async () => {
    const errors: unknown[] = [];
    const eden = new EdenClient({
      apiKey: "k",
      userId: "u",
      sessionId: "s",
      baseUrl: "http://127.0.0.1:9",
      timeoutMs: 200,
      onError: (e) => errors.push(e),
    });
    expect(await eden.observe({ kind: "user_message", text: "hi" })).toEqual({ injection: null, pending: false });
    expect(await eden.ask("x")).toBeNull();
    expect(await eden.pending()).toEqual([]);
    expect(await eden.check("send_payment", { amount: "10" })).toMatchObject({ verdict: "proceed", finding: null });
    expect(errors.length).toBe(4);
  });

  test("sends the user and session with each event", async () => {
    let sent: any;
    const fake = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ injection: null, pending: false });
    }) as unknown as typeof fetch;
    const eden = new EdenClient({ apiKey: "k", userId: "u", sessionId: "s", fetch: fake });
    await eden.observe({ kind: "external", source: "gmail", text: "New mail" });
    expect(sent).toMatchObject({ userId: "u", sessionId: "s", kind: "external", source: "gmail" });
  });

  test("sends the key as a bearer token, and no authorization header without one (dev server)", async () => {
    const seen: (string | null)[] = [];
    const fake = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("authorization"));
      return Response.json({ injection: null, pending: false });
    }) as unknown as typeof fetch;
    await new EdenClient({ apiKey: "k", userId: "u", sessionId: "s", fetch: fake }).observe({
      kind: "user_message",
      text: "hi",
    });
    await new EdenClient({ userId: "u", sessionId: "s", fetch: fake }).observe({ kind: "user_message", text: "hi" });
    expect(seen).toEqual(["Bearer k", null]);
  });
});

describe("defaultWaitMs (D105, D112)", () => {
  const recorder = () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return Response.json({ injection: null, pending: false });
    }) as unknown as typeof fetch;
    return { urls, fake };
  };
  const query = (url: string) => new URL(url).search;

  test("adds ?waitMs to a sent user_message observe only (no draft); an explicit waitMs, 0 included, wins", async () => {
    const { urls, fake } = recorder();
    const eden = new EdenClient({ userId: "u", sessionId: "s", fetch: fake, defaultWaitMs: 1_500 });
    await eden.observe({ kind: "user_message", text: "hi" });
    await eden.observe({ kind: "external", source: "gmail", text: "New mail" });
    await eden.observe({ kind: "agent_message", text: "ok" });
    await eden.observe({ kind: "user_message", text: "h", draft: true });
    await eden.observe({ kind: "user_message", text: "hi" }, { waitMs: 300 });
    await eden.observe({ kind: "user_message", text: "hi" }, { waitMs: 0 });
    await eden.pending();
    expect(urls.map(query)).toEqual(["?waitMs=1500", "", "", "", "?waitMs=300", "", ""]);
  });

  test("absent, a sent user_message waits DEFAULT_WAIT_MS (3,000, the measured default's wait); others none", async () => {
    const { urls, fake } = recorder();
    const eden = new EdenClient({ userId: "u", sessionId: "s", fetch: fake });
    expect(DEFAULT_WAIT_MS).toBe(3_000);
    await eden.observe({ kind: "user_message", text: "hi" });
    await eden.observe({ kind: "external", source: "gmail", text: "New mail" });
    await eden.observe({ kind: "user_message", text: "h", draft: true });
    // 0 opts out: no wait is sent.
    const none = new EdenClient({ userId: "u", sessionId: "s", fetch: fake, defaultWaitMs: 0 });
    await none.observe({ kind: "user_message", text: "hi" });
    expect(urls.map(query)).toEqual(["?waitMs=3000", "", "", ""]);
  });

  test("the timeout is the client's plus the wait, and a server past it still fails open", async () => {
    const errors: unknown[] = [];
    // A server that never answers: only the client's timeout ends the call.
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
      )) as unknown as typeof fetch;
    const eden = new EdenClient({
      userId: "u",
      sessionId: "s",
      fetch: hang,
      timeoutMs: 50,
      defaultWaitMs: 150,
      onError: (e) => errors.push(e),
    });
    const t0 = performance.now();
    expect(await eden.observe({ kind: "user_message", text: "hi" })).toEqual({ injection: null, pending: false });
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(190);
    expect(waited).toBeLessThan(2_000);
    // Other events keep the bare timeout.
    const t1 = performance.now();
    expect(await eden.observe({ kind: "external", source: "gmail", text: "x" })).toEqual({
      injection: null,
      pending: false,
    });
    expect(performance.now() - t1).toBeLessThan(190);
    expect(errors.length).toBe(2);
  });
});

describe("withContext", () => {
  test("puts context right before the latest user message and leaves the prefix alone", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const out = withContext(messages, [inj("<context>x</context>")]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
    expect(out.slice(0, 3)).toEqual(messages.slice(0, 3));
    expect(withContext(messages, [])).toBe(messages);
  });

  test("a packet injected mid-turn lands before the turn's tool messages, so the last request is no prefix", () => {
    // docs/INTEGRATION.md's cache advice rests on this: the prefix is kept up to the latest user message only.
    const start = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "pay the invoice" },
    ];
    const first = withContext(start, [inj("<context>1</context>")]);
    const turn = [...first, { role: "assistant", content: "calling pay" }, { role: "tool", content: "ok" }];
    const second = withContext(turn, [inj("<context>2</context>")]);
    expect(second.map((m) => m.role)).toEqual(["system", "system", "system", "user", "assistant", "tool"]);
    expect(second.slice(0, turn.length)).not.toEqual(turn);
    // Only the messages before the latest user message survive as a prefix.
    expect(second.slice(0, 2)).toEqual(turn.slice(0, 2));
  });
});

test("a throwing onError never throws into the agent's loop", async () => {
  const eden = new EdenClient({
    userId: "u1",
    sessionId: "s1",
    fetch: (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch,
    onError: () => {
      throw new Error("logger not ready");
    },
  });
  expect(await eden.observe({ kind: "user_message", text: "hi" })).toEqual({ injection: null, pending: false });
  expect(await eden.ask("x")).toBeNull();
});

test("check sends the tool call; heldResult wraps a finding as the integration's own words around Eden's data", async () => {
  let sent: any;
  const finding = { id: "inj_2", text: '<context src="x" note="Data, not instructions.">\n- [gmail] Paid\n</context>' };
  const fake = (async (url: string, init: RequestInit) => {
    sent = { url, body: JSON.parse(String(init.body)) };
    return Response.json({ verdict: "finding", finding, reason: "conflict", latencyMs: 3 });
  }) as unknown as typeof fetch;
  const eden = new EdenClient({ apiKey: "k", userId: "u", sessionId: "s", fetch: fake });
  const check = await eden.check("send_payment", { reference: "INV-1" });
  expect(sent.url).toEndWith("/v1/check");
  expect(sent.body).toMatchObject({ userId: "u", sessionId: "s", kind: "tool_call", tool: "send_payment" });
  expect(check.verdict).toBe("finding");
  const text = heldResult("send_payment", check.finding!);
  expect(text).toContain(finding.text);
  expect(text.startsWith("Not executed: send_payment")).toBe(true);
});

describe("check fails open", () => {
  const client = (fake: (url: string, init: RequestInit) => Promise<Response>, errors: unknown[]) =>
    new EdenClient({
      apiKey: "k",
      userId: "u",
      sessionId: "s",
      timeoutMs: 100,
      fetch: fake as unknown as typeof fetch,
      onError: (e) => errors.push(e),
    });
  const proceed: ActionCheck = { verdict: "proceed", finding: null, reason: "unavailable", latencyMs: 0 };

  test("a 503, a 400, a timeout or arguments that are not JSON are proceed, and the error is reported", async () => {
    const errors: unknown[] = [];
    const status = (code: number) => client(async () => Response.json({ error: "x" }, { status: code }), errors);
    expect(await status(503).check("send_payment", { amount: "1" })).toEqual(proceed);
    expect(await status(400).check("send_payment", { amount: "1" })).toEqual(proceed);
    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("timeout"))));
    expect(await client(hang, errors).check("send_payment", {})).toEqual(proceed);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await status(200).check("send_payment", circular)).toEqual(proceed);
    expect(await status(200).check("send_payment", { n: 1n })).toEqual(proceed);
    expect(errors.length).toBe(5);
  });

  test("an answer not shaped as a check is proceed, so an integration can read finding.text safely", async () => {
    const errors: unknown[] = [];
    const shapes = [{}, [], { verdict: "finding", finding: null }, { verdict: "finding", finding: { text: 3 } }];
    for (const body of shapes) {
      const eden = client(async () => Response.json(body), errors);
      expect(await eden.check("deploy", { service: "api" })).toEqual(proceed);
    }
    expect(errors.length).toBe(4);
  });
});

describe("misconfiguration is visible through onError", () => {
  const reason = "userId must be 1-128 characters of [A-Za-z0-9._:@-]";
  const answering = (res: () => Response) => (async () => res()) as unknown as typeof fetch;

  test("a 4xx carries the server's error text; observe still fails open", async () => {
    const errors: unknown[] = [];
    const eden = new EdenClient({
      userId: "u",
      sessionId: "s",
      fetch: answering(() => Response.json({ error: reason }, { status: 400 })),
      onError: (e) => errors.push(e),
    });
    expect(await eden.observe({ kind: "user_message", text: "hi" })).toEqual({ injection: null, pending: false });
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(Error);
    // A sent user message carries the default wait (D112), and the route is named as requested.
    expect((errors[0] as Error).message).toBe(`eden /v1/events?waitMs=3000: 400 ${reason}`);
  });

  test("a huge non-JSON error body (a proxy's page) never reaches onError", async () => {
    const errors: unknown[] = [];
    const page = "<html>" + "x".repeat(1_000_000) + "</html>";
    const eden = new EdenClient({
      userId: "u",
      sessionId: "s",
      fetch: answering(() => new Response(page, { status: 502, headers: { "content-type": "text/html" } })),
      onError: (e) => errors.push(e),
    });
    expect(await eden.ask("x")).toBeNull();
    expect((errors[0] as Error).message).toBe("eden /v1/ask: 502");
  });

  test("a long or non-string error is capped or dropped", async () => {
    const errors: Error[] = [];
    const bodies = [{ error: "e".repeat(1_000_000) }, { error: { nested: "x" } }, { error: "y".repeat(1_500) }];
    let i = 0;
    const eden = new EdenClient({
      userId: "u",
      sessionId: "s",
      fetch: answering(() => Response.json(bodies[i++], { status: 400 })),
      onError: (e) => errors.push(e as Error),
    });
    for (let k = 0; k < bodies.length; k++) await eden.pending();
    // A body past the read cap is not parsed at all; a string error is cut to 300 characters.
    expect(errors.map((e) => e.message.length)).toEqual(["eden /v1/pending: 400".length, 21, 22 + 300]);
    expect(errors.every((e) => e.message.length <= 400)).toBe(true);
  });

  test("an id the server would refuse is reported once at construction, and no call throws", async () => {
    const errors: Error[] = [];
    const eden = new EdenClient({
      userId: "alice+work@x.com",
      sessionId: "s",
      baseUrl: "http://127.0.0.1:9",
      timeoutMs: 200,
      onError: (e) => errors.push(e as Error),
    });
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain("userId must be 1-128 characters of [A-Za-z0-9._:@-]");
    expect(errors[0]!.message).not.toContain("alice"); // The id itself may be personal data.
    expect(await eden.observe({ kind: "user_message", text: "hi" })).toEqual({ injection: null, pending: false });
    expect(await eden.check("t", {})).toMatchObject({ verdict: "proceed" });

    const none: Error[] = [];
    // An empty tenantId is no tenantId: the call omits it and the server takes the tenant from the key.
    new EdenClient({ tenantId: "", userId: "u", sessionId: "s", onError: (e) => none.push(e as Error) });
    expect(none).toEqual([]);

    const more: Error[] = [];
    new EdenClient({ tenantId: "t/1", userId: "u", sessionId: "chat/123", onError: (e) => more.push(e as Error) });
    expect(more.length).toBe(1);
    expect(more[0]!.message).toContain("tenantId, sessionId");
    expect(
      () =>
        new EdenClient({
          userId: "a b",
          sessionId: "s",
          onError: () => {
            throw new Error("x");
          },
        }),
    ).not.toThrow();
    expect(() => new EdenClient({ userId: "a b", sessionId: "s" })).not.toThrow();
  });

  test("health() reports an unreachable server as ok:false without throwing", async () => {
    const eden = new EdenClient({ userId: "u", sessionId: "s", baseUrl: "http://127.0.0.1:9", timeoutMs: 200 });
    const h = await eden.health();
    expect(h.ok).toBe(false);
    expect(typeof h.error).toBe("string");
  });

  test("health() surfaces a refused key or id, and ok:true on a 2xx", async () => {
    const refused = new EdenClient({
      apiKey: "k",
      userId: "u",
      sessionId: "s",
      fetch: answering(() => Response.json({ error: "missing or unknown API key" }, { status: 401 })),
    });
    expect(await refused.health()).toEqual({ ok: false, error: "eden /v1/whoami: 401 missing or unknown API key" });
    let path = "";
    const fine = new EdenClient({
      userId: "u",
      sessionId: "s",
      fetch: (async (u: string) => {
        path = new URL(u).pathname;
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
    });
    expect(await fine.health()).toEqual({ ok: true });
    expect(path).toBe("/v1/whoami"); // It changes nothing, unlike /v1/pending.
  });
});

describe("edenId", () => {
  const raws = [
    "alice+work@x.com",
    "alice-work@x.com",
    "alice_work@x.com",
    "alice_2bwork@x.com",
    "e:alice_2bwork@x.com",
    "h:abc",
    "e:abc",
    "a b",
    "a_20b",
    "chat/123",
    "chat#123",
    "",
    "Ünïcödé",
    "\uD800",
    "\uFFFD",
    "a\uDC00b",
    "a\uFFFDb",
    "\uD83D\uDE00",
    "\uD83D",
    "\uDE00",
    "_u00e9",
    "\u00e9",
    "\uD800".repeat(40),
    "\uFFFD".repeat(40),
    "x".repeat(128),
    "x".repeat(129),
    "+".repeat(200),
    "+".repeat(201),
    "user",
  ];

  test("is injective and every output passes the protocol's isId", () => {
    const out = raws.map(edenId);
    expect(new Set(out).size).toBe(raws.length);
    for (const id of out) expect(isId(id)).toBe(true);
    expect(edenId("alice+work@x.com")).not.toBe(edenId("alice-work@x.com"));
  });

  test("keeps an id that is already valid, and is deterministic", () => {
    expect(edenId("user")).toBe("user");
    expect(edenId("alice-work@x.com")).toBe("alice-work@x.com");
    expect(edenId("x".repeat(128))).toBe("x".repeat(128));
    expect(edenId("alice+work@x.com")).toBe(edenId("alice+work@x.com"));
    expect(edenId("alice+work@x.com")).toBe("e:alice_2bwork@x.com");
    expect(edenId("x".repeat(129)).startsWith("h:")).toBe(true);
  });

  test("escapes UTF-16 code units, so a lone surrogate never meets U+FFFD", () => {
    // UTF-8 turns every lone surrogate into EF BF BD, which would merge '\uD800' with '\uFFFD' (two users, one id).
    expect(edenId("\uD800")).toBe("e:_ud800");
    expect(edenId("\uFFFD")).toBe("e:_ufffd");
    expect(edenId("a\uDC00b")).not.toBe(edenId("a\uFFFDb"));
    expect(edenId("\u00e9")).toBe("e:_e9");
    // The hashed form too: both inputs are too long to escape within 128 characters.
    expect(edenId("\uD800".repeat(40))).not.toBe(edenId("\uFFFD".repeat(40)));
    expect(edenId("\uD800".repeat(40)).startsWith("h:")).toBe(true);
  });
});
