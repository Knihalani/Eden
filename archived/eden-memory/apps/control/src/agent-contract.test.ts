import { afterAll, describe, expect, test } from "bun:test";
import { Store } from "./store";
import { createHandler } from "./server";
import { useTempEdenHome } from "./test-home";
import { registryFrom } from "@eden/runtime";
import { replayRegistry } from "@eden/shadow";
import { createTicketShip, runNaive, toNaiveTrace, WITNESS_IDS } from "../../../packages/runtime/src/ticketship";
import type { StretchTrace } from "@eden/ir";

useTempEdenHome();

// Same pin as golden.test.ts: a DATABASE_URL in .env would treat this as
// managed and refuse unscoped Approve / wrap.
const PREV_DEV = process.env.EDEN_DEV;
const PREV_AUTO = process.env.EDEN_AUTO_APPROVE;
process.env.EDEN_DEV = "1";
delete process.env.EDEN_AUTO_APPROVE;
afterAll(() => {
  process.env.EDEN_DEV = PREV_DEV;
  if (PREV_AUTO === undefined) delete process.env.EDEN_AUTO_APPROVE;
  else process.env.EDEN_AUTO_APPROVE = PREV_AUTO;
});

async function naiveTraces(n: number): Promise<StretchTrace[]> {
  const out: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const world = createTicketShip({ llmMs: 0 });
    const id = WITNESS_IDS[i % 3]!;
    const run = await runNaive(world, id, { skipVerifyP: 0, seed: 7 + i });
    const base = toNaiveTrace(`g${i}`, id, run);
    const events = base.events.map((e) => ({ ...e, duration_ms: e.name === "draftReply" ? 5000 : 100 }));
    out.push({ ...base, duration_ms: events.reduce((a, e) => a + (e.duration_ms ?? 0), 0), events });
  }
  return out;
}

function shipWorld() {
  const world = createTicketShip({ llmMs: 0 });
  const store = new Store(":memory:");
  const fetchHandler = createHandler({
    store,
    token: "eden_dev",
    registry: registryFrom(world.tools),
    island: world.island,
    sandboxFor: (t) => replayRegistry(registryFrom(world.tools), t),
  });
  const auth = (path: string, init: RequestInit = {}) =>
    new Request(`http://x${path}`, {
      ...init,
      headers: { authorization: "Bearer eden_dev", "content-type": "application/json", ...(init.headers ?? {}) },
    });
  return { world, store, fetchHandler, auth };
}

async function approveTicketShip(
  fetchHandler: (req: Request) => Promise<Response>,
  auth: (path: string, init?: RequestInit) => Request,
) {
  const traces = await naiveTraces(10);
  const posted = await fetchHandler(auth("/v1/traces", { method: "POST", body: JSON.stringify({ traces }) }));
  expect(posted.status).toBe(200);
  const compiled = await fetchHandler(auth("/v1/compile", { method: "POST", body: "{}" }));
  expect(compiled.status).toBe(200);
  const inbox = (await (await fetchHandler(auth("/v1/inbox"))).json()) as {
    candidates: Array<{ id: string; verdict: string; program: { name: string; sequence?: string[] } | null }>;
  };
  const pass = inbox.candidates.find((c) => c.verdict === "PASS" && c.program);
  expect(pass).toBeTruthy();
  const approved = await fetchHandler(auth(`/v1/tools/${pass!.id}/approve`, { method: "POST", body: "{}" }));
  expect(approved.status).toBe(200);
  return pass!;
}

describe("agent contract", () => {
  test("POST /v1/wrap no auth → 401", async () => {
    const { fetchHandler } = shipWorld();
    const res = await fetchHandler(
      new Request("http://x/v1/wrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
    const unknown = await fetchHandler(new Request("http://x/v1/no-such-route"));
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "unauthorized" });
  });

  test("POST /v1/wrap unknown name → 200 {action:original}", async () => {
    const { fetchHandler, auth } = shipWorld();
    const res = await fetchHandler(
      auth("/v1/wrap", { method: "POST", body: JSON.stringify({ name: "no-such-tool", args: { id: "T-100" } }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: "original" });
    expect(res.headers.get("x-eden-version")).toBe("1");
  });

  test("POST /v1/wrap after Approve plays T-100 with wrap-run facts", async () => {
    const { fetchHandler, auth } = shipWorld();
    const pass = await approveTicketShip(fetchHandler, auth);
    const name = pass.program!.name;

    const wrapRes = await fetchHandler(
      auth("/v1/wrap", { method: "POST", body: JSON.stringify({ name, args: { id: "T-100" } }) }),
    );
    expect(wrapRes.status).toBe(200);
    const wrapBody = (await wrapRes.json()) as { action?: string; facts?: unknown };
    expect(wrapBody.action).toBe("play");

    const viaArguments = await fetchHandler(
      auth("/v1/wrap", { method: "POST", body: JSON.stringify({ name, arguments: { id: "T-100" } }) }),
    );
    expect(viaArguments.status).toBe(200);
    expect(await viaArguments.json()).toEqual(wrapBody);

    const viaStringArguments = await fetchHandler(
      auth("/v1/wrap", { method: "POST", body: JSON.stringify({ name, arguments: JSON.stringify({ id: "T-100" }) }) }),
    );
    expect(viaStringArguments.status).toBe(200);
    expect(await viaStringArguments.json()).toEqual(wrapBody);

    const runRes = await fetchHandler(
      auth("/v1/wrap-run", { method: "POST", body: JSON.stringify({ toolId: pass.id, input: { id: "T-100" } }) }),
    );
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { value?: unknown };
    expect(wrapBody.facts).toEqual(runBody.value);
    expect(wrapBody.facts).toEqual({ notified: true, id: "T-100" });

    const first = pass.program!.sequence?.[0];
    if (first) {
      const viaSeq = await fetchHandler(
        auth("/v1/wrap", { method: "POST", body: JSON.stringify({ name: first, args: { id: "T-100" } }) }),
      );
      expect(viaSeq.status).toBe(200);
      const seqBody = (await viaSeq.json()) as { action?: string; facts?: unknown };
      expect(seqBody.action).toBe("play");
      expect(seqBody.facts).toEqual({ notified: true, id: "T-100" });
    }
  });

  test("POST /v1/ingest three stretches compiles and does not Approve", async () => {
    const { fetchHandler, auth, store } = shipWorld();
    const traces = await naiveTraces(3);
    for (const t of traces) {
      const events = t.events.map((e, i) => ({
        event_id: `${t.id}-${i}`,
        name: e.name,
        args: e.args,
        result: e.result,
        ok: e.ok,
        duration_ms: e.duration_ms,
      }));
      const res = await fetchHandler(
        auth("/v1/ingest", {
          method: "POST",
          body: JSON.stringify({ run_id: t.id, events, stretch_end: true, agent_id: "sdk_ts" }),
        }),
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { ok?: boolean; accepted?: number };
      expect(body.ok).toBe(true);
      expect(body.accepted).toBeGreaterThanOrEqual(1);
    }
    expect(store.tracesCount()).toBeGreaterThanOrEqual(3);
    expect(store.candidatesCount() + store.tracesCount()).toBeGreaterThan(3);
    expect(store.tools().filter((t) => t.state === "live")).toHaveLength(0);

    const emptySeal = await fetchHandler(
      auth("/v1/ingest", {
        method: "POST",
        body: JSON.stringify({ run_id: "empty-seal", events: [], stretch_end: true }),
      }),
    );
    expect(emptySeal.status).toBe(202);
    expect(await emptySeal.json()).toEqual({ ok: true, accepted: 0 });
  });

  test("POST /v1/dispatch empty messages → {tools:[]}", async () => {
    const { fetchHandler, auth } = shipWorld();
    const empty = await fetchHandler(auth("/v1/dispatch", { method: "POST", body: JSON.stringify({ messages: [] }) }));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ tools: [] });
    const missing = await fetchHandler(auth("/v1/dispatch", { method: "POST", body: "{}" }));
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ tools: [] });
  });

  test("POST /v1/play unknown → 404", async () => {
    const { fetchHandler, auth } = shipWorld();
    const res = await fetchHandler(auth("/v1/play", { method: "POST", body: JSON.stringify({ name: "nope" }) }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("not live");
  });

  test("wrap miss is original not 500; play after Approve; contract is fetchable", async () => {
    const { fetchHandler, auth } = shipWorld();
    const miss = await fetchHandler(
      auth("/v1/wrap", { method: "POST", body: JSON.stringify({ name: "lookupTicket", args: { id: "T-100" } }) }),
    );
    expect(miss.status).toBe(200);
    expect(await miss.json()).toEqual({ action: "original" });

    const bad = await fetchHandler(auth("/v1/wrap", { method: "POST", body: JSON.stringify({ args: {} }) }));
    expect(bad.status).toBe(400);

    const spec = await fetchHandler(auth("/v1/openapi.json"));
    expect(spec.status).toBe(200);
    const doc = (await spec.json()) as { paths?: Record<string, unknown>; info?: { version?: string } };
    expect(doc.info?.version).toBe("1");
    for (const path of [
      "/v1/wrap",
      "/v1/ingest",
      "/v1/dispatch",
      "/v1/play",
      "/v1/wrap-run",
      "/v1/traces",
      "/v1/compile",
      "/v1/chat/completions",
      "/v1/messages",
      "/health",
    ]) {
      expect(doc.paths?.[path]).toBeTruthy();
    }

    const pass = await approveTicketShip(fetchHandler, auth);
    const played = await fetchHandler(
      auth("/v1/play", { method: "POST", body: JSON.stringify({ name: pass.program!.name, args: { id: "T-100" } }) }),
    );
    expect(played.status).toBe(200);
    const playBody = (await played.json()) as { ok?: boolean; value?: unknown };
    expect(playBody.ok).toBe(true);
    expect(playBody.value).toEqual({ notified: true, id: "T-100" });

    const dispatch = await fetchHandler(
      auth("/v1/dispatch", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "resolve ticket T-100" }] }),
      }),
    );
    expect(dispatch.status).toBe(200);
    const d = (await dispatch.json()) as { tools: unknown[] };
    expect(d.tools.length).toBeLessThanOrEqual(1);

    const viaUrl = await fetchHandler(
      auth("/v1/dispatch", { method: "POST", body: JSON.stringify({ url: "resolve ticket T-100" }) }),
    );
    expect(viaUrl.status).toBe(200);
    expect(((await viaUrl.json()) as { tools: unknown[] }).tools.length).toBe(d.tools.length);

    const nope = await fetchHandler(auth("/v1/no-such-route"));
    expect(nope.status).toBe(404);
    expect(nope.headers.get("x-eden-version")).toBe("1");
    expect(await nope.json()).toEqual({ error: "not found" });
  });

  test("chat without a key is 401; eden_dev does not go to OpenAI", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { fetchHandler, auth } = shipWorld();
      const noKey = await fetchHandler(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "m", messages: [] }),
        }),
      );
      expect(noKey.status).toBe(401);
      const dev = await fetchHandler(
        auth("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) }),
      );
      expect(dev.status).toBe(200);
      const body = (await dev.json()) as {
        model?: string;
        fail_open?: boolean;
        choices?: Array<{ message?: { content?: string } }>;
      };
      expect(body.model).toBe("eden");
      expect(body.fail_open).toBe(true);
      expect(body.choices?.[0]?.message?.content).toMatch(/OPENAI_API_KEY/);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  test("chat with T-100 plays compiled facts when wrap is live and there is no model key", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { fetchHandler, auth } = shipWorld();
      await approveTicketShip(fetchHandler, auth);
      const res = await fetchHandler(
        auth("/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "user", content: "resolve ticket T-100" }],
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> };
      expect(body.model).toBe("eden");
      expect(JSON.parse(body.choices?.[0]?.message?.content || "{}")).toEqual({ notified: true, id: "T-100" });
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});
