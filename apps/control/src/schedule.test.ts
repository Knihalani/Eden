import { afterAll, describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import { registryFrom } from "@eden/runtime";
import { cronMatches, parseCron, tickWindow, toolMayFire } from "./schedule";
import { createHandler } from "./server";
import { useTempEdenHome } from "./test-home";
import { Store } from "./store";

useTempEdenHome();

const PREV_DEV = process.env.EDEN_DEV;
process.env.EDEN_DEV = "1";
afterAll(() => {
  process.env.EDEN_DEV = PREV_DEV;
});

const TOKEN = "eden_dev";
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const passManifest = {
  llmReduction: 5,
  latencyReduction: 2,
  costReduction: 2,
  skipRateBefore: 0.1,
  skipRateAfter: 0,
  nShadow: 6,
  tokensMeasured: true,
  tokensSaved: 400,
  timeMeasured: false,
  timeSavedMs: null,
};

function literalProgram(id: string): StretchProgram {
  return {
    id,
    version: "v1",
    name: id,
    description: "scheduled",
    inputSchema: { type: "object" },
    steps: [],
    returns: { kind: "literal", value: { ok: true } },
    contract: { witnesses: 0, minLlmReduction: 2, allowExact: true },
    manifest: null,
  };
}

function putLive(store: Store, id = "sched_live"): void {
  const program = literalProgram(id);
  store.putTool({
    id,
    name: id,
    version: program.version,
    program,
    state: "live",
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

function putPassCandidate(store: Store, id = "cand_sched"): StretchProgram {
  const program = literalProgram(id);
  store.putCandidate({
    id,
    sequence: [],
    program,
    refusal: null,
    verdict: "PASS",
    manifest: passManifest,
    created_at: Date.now(),
  });
  return program;
}

function handler(store = new Store(":memory:")) {
  const fetchHandler = createHandler({ store, token: TOKEN, registry: registryFrom({}) });
  return { store, fetchHandler };
}

const FROZEN = new Date(Date.UTC(2026, 7, 29, 14, 30, 12));
const FROZEN_MS = FROZEN.getTime();
const DUE_CRON = "30 14 * * *";

describe("posix cron", () => {
  test("five fields; frozen now matches 30 14 * * *", () => {
    expect(parseCron(DUE_CRON)).toBeTruthy();
    expect(cronMatches(DUE_CRON, FROZEN)).toBe(true);
    expect(cronMatches("0 0 * * *", FROZEN)).toBe(false);
    expect(cronMatches("* * * * *", FROZEN)).toBe(true);
  });

  test("bad cron is null — no mutation possible", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("* * *")).toBeNull();
    expect(parseCron("* * * * * *")).toBeNull();
    expect(parseCron("60 * * * *")).toBeNull();
    expect(parseCron("0 24 * * *")).toBeNull();
    expect(parseCron("@hourly")).toBeNull();
    expect(parseCron("not a cron")).toBeNull();
    expect(cronMatches("bad", FROZEN)).toBe(false);
  });
});

describe("scheduled programs", () => {
  test("Approve a tool → schedule rows still 0 (nothing schedules itself)", async () => {
    const { store, fetchHandler } = handler();
    putPassCandidate(store, "ship_me");
    expect(store.schedulesCount()).toBe(0);
    const approved = await fetchHandler(
      new Request("http://x/v1/tools/ship_me/approve", { method: "POST", headers: auth, body: "{}" }),
    );
    expect(approved.status).toBe(200);
    expect(store.tool("ship_me")?.state).toBe("live");
    expect(store.schedulesCount()).toBe(0);
  });

  test("POST compile does not insert a schedule row", async () => {
    const { store, fetchHandler } = handler();
    putLive(store);
    const compiled = await fetchHandler(new Request("http://x/v1/compile", { method: "POST", headers: auth, body: "{}" }));
    expect(compiled.status).toBe(200);
    expect(store.schedulesCount()).toBe(0);
  });

  test("wrap-run does not insert a schedule row", async () => {
    const { store, fetchHandler } = handler();
    putLive(store);
    const run = await fetchHandler(
      new Request("http://x/v1/wrap-run", { method: "POST", headers: auth, body: JSON.stringify({ toolId: "sched_live" }) }),
    );
    expect(run.status).toBe(200);
    expect(store.schedulesCount()).toBe(0);
    expect(store.receiptsCount()).toBe(1);
  });

  test("POST schedule on live tool → 200; tick matching cron → 1 receipt, same columns as wrap-run", async () => {
    const { store, fetchHandler } = handler();
    putLive(store, "a");
    putLive(store, "b");

    const wrap = await fetchHandler(
      new Request("http://x/v1/wrap-run", { method: "POST", headers: auth, body: JSON.stringify({ toolId: "a" }) }),
    );
    expect(wrap.status).toBe(200);
    const wrapRow = store.receiptsFor("a")[0]!;
    expect(wrapRow).toBeTruthy();

    const created = await fetchHandler(
      new Request("http://x/v1/tools/b/schedule", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ cron: DUE_CRON }),
      }),
    );
    expect(created.status).toBe(200);
    expect(store.tool("b")?.state).toBe("live");
    expect(store.schedulesCount()).toBe(1);
    expect(store.receiptsFor("b")).toHaveLength(0);

    const tick = await fetchHandler(
      new Request("http://x/v1/schedule/tick", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ now: FROZEN_MS }),
      }),
    );
    expect(tick.status).toBe(200);
    const tickBody = (await tick.json()) as { fired: number; paused: number };
    expect(tickBody.fired).toBe(1);
    expect(tickBody.paused).toBe(0);
    expect(store.receiptsFor("b")).toHaveLength(1);

    const schedRow = store.receiptsFor("b")[0]!;
    const got = await fetchHandler(new Request("http://x/v1/receipts?tool=b", { headers: auth }));
    const listed = (await got.json()) as { receipts: Array<Record<string, unknown>> };
    const shown = listed.receipts[0]!;
    expect(typeof schedRow.ms).toBe("number");
    expect(typeof schedRow.llm_calls).toBe("number");
    expect(typeof schedRow.cents).toBe("number");
    expect(schedRow.ok).toBe(1);
    expect(shown.ms).toBe(schedRow.ms);
    expect(shown.llm_calls).toBe(schedRow.llm_calls);
    expect(shown.cents).toBe(schedRow.cents);
    expect(shown.ok).toBe(1);
    expect(shown.outcome).toBe("ok");
    expect(shown.source).toBe("schedule");
    for (const col of ["id", "tool_id", "version", "ms", "llm_calls", "cents", "ok", "created_at"] as const) {
      expect(col in wrapRow).toBe(true);
      expect(col in schedRow).toBe(true);
    }
    expect(typeof wrapRow.ms).toBe("number");
    expect(typeof wrapRow.llm_calls).toBe("number");
    expect(typeof wrapRow.cents).toBe("number");
    expect(wrapRow.ok).toBe(1);
  });

  test("pause → tick fires 0, no new receipt; resume can fire again", async () => {
    const { store, fetchHandler } = handler();
    putLive(store);
    await fetchHandler(
      new Request("http://x/v1/tools/sched_live/schedule", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ cron: "* * * * *" }),
      }),
    );
    const paused = await fetchHandler(
      new Request("http://x/v1/tools/sched_live/pause", { method: "POST", headers: auth, body: "{}" }),
    );
    expect(paused.status).toBe(200);
    expect(store.tool("sched_live")?.state).toBe("paused");
    expect(toolMayFire(store.tool("sched_live")).ok).toBe(false);

    const dead = await fetchHandler(
      new Request("http://x/v1/schedule/tick", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ now: FROZEN_MS }),
      }),
    );
    const deadBody = (await dead.json()) as { fired: number; paused: number };
    expect(deadBody.fired).toBe(0);
    expect(deadBody.paused).toBe(1);
    expect(store.receiptsCount()).toBe(0);

    const resumed = await fetchHandler(
      new Request("http://x/v1/tools/sched_live/resume", { method: "POST", headers: auth, body: "{}" }),
    );
    expect(resumed.status).toBe(200);
    const liveTick = await fetchHandler(
      new Request("http://x/v1/schedule/tick", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ now: FROZEN_MS }),
      }),
    );
    expect(((await liveTick.json()) as { fired: number }).fired).toBe(1);
    expect(store.receiptsCount()).toBe(1);
  });

  test("rolled_back never fires", async () => {
    const { store, fetchHandler } = handler();
    const program = literalProgram("rb");
    store.putTool({
      id: "rb",
      name: "rb",
      version: "v1",
      program,
      state: "rolled_back",
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    store.putSchedule({
      id: "s1",
      tool_id: "rb",
      cron: "* * * * *",
      input: null,
      last_tick: null,
      created_at: Date.now(),
    });
    const tick = await fetchHandler(
      new Request("http://x/v1/schedule/tick", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ now: FROZEN_MS }),
      }),
    );
    expect(((await tick.json()) as { fired: number }).fired).toBe(0);
    expect(store.receiptsCount()).toBe(0);
  });

  test("candidate / not live → 409; creating schedule does not set state live", async () => {
    const { store, fetchHandler } = handler();
    putPassCandidate(store, "only_cand");
    const res = await fetchHandler(
      new Request("http://x/v1/tools/only_cand/schedule", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ cron: "* * * * *" }),
      }),
    );
    expect(res.status).toBe(409);
    expect(store.schedulesCount()).toBe(0);
    expect(store.tool("only_cand")).toBeUndefined();
    expect(store.liveCount()).toBe(0);
  });

  test("bad cron → 400, no row / no fire", async () => {
    const { store, fetchHandler } = handler();
    putLive(store);
    for (const cron of ["not a cron", "* * *", "60 * * * *", "@hourly", ""]) {
      const res = await fetchHandler(
        new Request("http://x/v1/tools/sched_live/schedule", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ cron }),
        }),
      );
      expect(res.status).toBe(400);
    }
    expect(store.schedulesCount()).toBe(0);
    const tick = await fetchHandler(
      new Request("http://x/v1/schedule/tick", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ now: FROZEN_MS }),
      }),
    );
    expect(((await tick.json()) as { fired: number }).fired).toBe(0);
    expect(store.receiptsCount()).toBe(0);
  });

  test("two ticks in the same minute with * * * * *: at most one fire", async () => {
    const { store, fetchHandler } = handler();
    putLive(store);
    await fetchHandler(
      new Request("http://x/v1/tools/sched_live/schedule", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ cron: "* * * * *" }),
      }),
    );
    const a = await fetchHandler(
      new Request("http://x/v1/schedule/tick", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ now: FROZEN_MS }),
      }),
    );
    const b = await fetchHandler(
      new Request("http://x/v1/schedule/tick", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ now: FROZEN_MS + 1_000 }),
      }),
    );
    expect(((await a.json()) as { fired: number }).fired).toBe(1);
    expect(((await b.json()) as { fired: number }).fired).toBe(0);
    expect(store.receiptsCount()).toBe(1);
    expect(tickWindow(FROZEN)).toBe(tickWindow(new Date(FROZEN_MS + 1_000)));
  });

  test("cron not due at frozen now does not fire", async () => {
    const { store, fetchHandler } = handler();
    putLive(store);
    await fetchHandler(
      new Request("http://x/v1/tools/sched_live/schedule", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ cron: "0 0 * * *" }),
      }),
    );
    const tick = await fetchHandler(
      new Request("http://x/v1/schedule/tick", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ now: FROZEN_MS }),
      }),
    );
    expect(((await tick.json()) as { fired: number }).fired).toBe(0);
    expect(store.receiptsCount()).toBe(0);
  });

  test("unauthenticated schedule create/fire refused", async () => {
    const { store, fetchHandler } = handler();
    putLive(store);
    const create = await fetchHandler(
      new Request("http://x/v1/tools/sched_live/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cron: "* * * * *" }),
      }),
    );
    expect(create.status).toBe(401);
    const tick = await fetchHandler(
      new Request("http://x/v1/schedule/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ now: FROZEN_MS }),
      }),
    );
    expect(tick.status).toBe(401);
    expect(store.schedulesCount()).toBe(0);
    expect(store.receiptsCount()).toBe(0);
  });

  test("org gate matches approve/pause: wrong org cannot create or fire", async () => {
    const prevDb = process.env.DATABASE_URL;
    const prevVercel = process.env.VERCEL;
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL;
    try {
      const { store, fetchHandler } = handler();
      putLive(store);
      await fetchHandler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: { ...auth, "x-eden-org": "org_a" },
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      const wrong = await fetchHandler(
        new Request("http://x/v1/tools/sched_live/schedule", {
          method: "POST",
          headers: { ...auth, "x-eden-org": "org_b" },
          body: JSON.stringify({ cron: "* * * * *" }),
        }),
      );
      expect(wrong.status).toBe(403);
      expect(store.schedulesCount()).toBe(0);
      const ok = await fetchHandler(
        new Request("http://x/v1/tools/sched_live/schedule", {
          method: "POST",
          headers: { ...auth, "x-eden-org": "org_a" },
          body: JSON.stringify({ cron: "* * * * *" }),
        }),
      );
      expect(ok.status).toBe(200);
      const fire = await fetchHandler(
        new Request("http://x/v1/schedule/tick", {
          method: "POST",
          headers: { ...auth, "x-eden-org": "org_b" },
          body: JSON.stringify({ now: FROZEN_MS }),
        }),
      );
      expect(fire.status).toBe(403);
      expect(store.receiptsCount()).toBe(0);
    } finally {
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
      if (prevVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prevVercel;
    }
  });

  test("GET/DELETE schedule; human gate unchanged", async () => {
    const { store, fetchHandler } = handler();
    putLive(store);
    const listed = await fetchHandler(new Request("http://x/v1/tools/sched_live/schedule", { headers: auth }));
    expect(((await listed.json()) as { schedule: null }).schedule).toBeNull();
    await fetchHandler(
      new Request("http://x/v1/tools/sched_live/schedule", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ cron: DUE_CRON, input: { id: "T-1" } }),
      }),
    );
    const got = await fetchHandler(new Request("http://x/v1/tools/sched_live/schedule", { headers: auth }));
    const body = (await got.json()) as { schedule: { cron: string; input: { id: string } } };
    expect(body.schedule.cron).toBe(DUE_CRON);
    expect(body.schedule.input.id).toBe("T-1");
    const del = await fetchHandler(
      new Request("http://x/v1/tools/sched_live/schedule", { method: "DELETE", headers: auth }),
    );
    expect(del.status).toBe(200);
    expect(store.schedulesCount()).toBe(0);
    expect(store.tool("sched_live")?.state).toBe("live");
  });
});
