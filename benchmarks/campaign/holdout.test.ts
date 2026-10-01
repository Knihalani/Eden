/**
 * Holdout campaign CI: world contracts, compileTraces, unique-work empty,
 * check() duplicates, and compileTraces → shadow goLive → wrap serve.
 *
 * Compile/check tests stay fast. The goLive test is allowed 60s.
 */
import { describe, expect, test } from "bun:test";
import { compileTraces } from "@eden/compile";
import { mulberry32 } from "@eden/measure";
import type { StretchTrace } from "@eden/ir";
import { type CallResult, type World, blockSeed } from "./worlds";
import { Session } from "./session";
import {
  CAL_SLOTS,
  CART_IDS,
  CART_WIDTH,
  CRM_IDS,
  HOLDOUT_WORLD_FACTORIES,
  NOISE_IDS,
  PAY_EMAILS,
  createCalendar,
  createCart,
  createCrm,
  createHoldoutNoise,
  createPayments,
  skusFor,
} from "./holdout-worlds";

process.env.CAMPAIGN_THINK_MS = "0";

const TIMEOUT = 5_000;

async function recordStretch(world: World, goal: Record<string, unknown>, seed: number): Promise<StretchTrace> {
  const tools = world.tools();
  const gen = world.script(goal, mulberry32(seed >>> 0));
  const events: StretchTrace["events"] = [];
  let sent: CallResult | undefined;
  let lastValue: unknown;
  for (;;) {
    const next = await gen.next(sent as never);
    if (next.done) break;
    const { tool, args } = next.value;
    const t0 = performance.now();
    let out: CallResult;
    try {
      const v = await tools[tool]!.execute(args);
      out = { ok: true, value: v };
      lastValue = v;
    } catch (err) {
      out = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    events.push({
      name: tool,
      args,
      result: out.ok ? out.value : { error: out.error },
      ok: out.ok,
      duration_ms: performance.now() - t0,
    });
    sent = out;
  }
  const completed = events.some((e) => e.ok && e.name === world.terminal);
  return {
    id: `${world.name}-${seed}`,
    events,
    input: goal,
    output: lastValue,
    llmCalls: events.length,
    duration_ms: Math.max(1, Math.round(events.reduce((a, e) => a + (e.duration_ms ?? 0), 0))),
    cost_cents: events.length,
    skipped: [],
    complete: completed,
  };
}

async function recordN(factory: () => World, goals: Array<Record<string, unknown>>, n = 4): Promise<StretchTrace[]> {
  const traces: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    traces.push(await recordStretch(factory(), goals[i % goals.length]!, 100 + i));
  }
  return traces;
}

describe("holdout worlds: contract", () => {
  test(
    "each world exposes tools, script, check",
    () => {
      for (const factory of [...HOLDOUT_WORLD_FACTORIES, createHoldoutNoise]) {
        const w = factory();
        expect(typeof w.tools).toBe("function");
        expect(typeof w.script).toBe("function");
        expect(typeof w.check).toBe("function");
        expect(typeof w.done).toBe("function");
        expect(typeof w.terminal).toBe("string");
        const tools = w.tools();
        expect(Object.keys(tools).length).toBeGreaterThan(0);
        for (const t of Object.values(tools)) {
          expect(typeof t.execute).toBe("function");
          expect(typeof t.description).toBe("string");
        }
      }
    },
    TIMEOUT,
  );

  test(
    "cart listCart returns object items { sku, qty }, not a string array",
    async () => {
      const w = createCart();
      const listed = await w.tools().listCart!.execute({ cart: CART_IDS[0] });
      const items = (listed as { items: unknown }).items;
      expect(Array.isArray(items)).toBe(true);
      expect((items as unknown[]).length).toBe(CART_WIDTH);
      expect(typeof (items as unknown[])[0]).toBe("object");
      expect(typeof (items as string[])[0]).not.toBe("string");
      const row = (items as Array<{ sku: string; qty: number }>)[0]!;
      expect(typeof row.sku).toBe("string");
      expect(typeof row.qty).toBe("number");
      expect(skusFor(CART_IDS[0]).length).toBe(CART_WIDTH);
    },
    TIMEOUT,
  );
});

describe("holdout worlds: compileTraces", () => {
  test(
    "crm / calendar / payments: 4 recorded stretches produce ≥1 program",
    async () => {
      const cases: Array<{ name: string; factory: () => World; goals: Array<Record<string, unknown>>; seq: string[] }> =
        [
          {
            name: "crm",
            factory: createCrm,
            goals: [...CRM_IDS].map((leadId) => ({ leadId })),
            seq: ["getLead", "enrichCompany", "createDeal", "assignOwner", "notifySlack"],
          },
          {
            name: "calendar",
            factory: createCalendar,
            goals: CAL_SLOTS.map((s) => ({ when: s.when, title: s.title })),
            seq: ["listBusy", "createEvent", "sendInvite", "addReminder"],
          },
          {
            name: "payments",
            factory: createPayments,
            goals: [...PAY_EMAILS].map((email) => ({ email })),
            seq: ["getCustomer", "createInvoice", "createCharge", "sendReceipt"],
          },
        ];
      for (const c of cases) {
        const traces = await recordN(c.factory, c.goals, 4);
        expect(traces.every((t) => t.complete)).toBe(true);
        const r = compileTraces(traces);
        console.log(
          `holdout compile ${c.name}: programs=${r.programs.length} \
seqs=${r.programs.map((p) => p.sequence.join("→")).join(" | ") || "(none)"} refusals=${r.refusals
            .map((x) => x.code ?? x.reason)
            .slice(0, 3)
            .join("; ")}`,
        );
        expect(r.programs.length, `${c.name} should compile ≥1 program`).toBeGreaterThanOrEqual(1);
        expect(r.programs[0]!.sequence).toEqual(c.seq);
        if (c.name === "payments") {
          const inv = r.programs[0]!.steps.find((s) => s.kind === "tool" && s.tool === "createInvoice");
          expect(inv && inv.kind === "tool" && inv.args.customerId).toEqual({
            kind: "from",
            step: "getCustomer",
            path: "customer.billing.id",
          });
        }
      }
    },
    TIMEOUT,
  );

  test(
    "cart: compiles a loop over { sku, qty } items (not a string array)",
    async () => {
      const goals = [...CART_IDS].map((cart) => ({ cart }));
      const traces = await recordN(createCart, goals, 4);
      expect(traces[0]!.events.filter((e) => e.name === "reserveSku").length).toBe(CART_WIDTH);
      const r = compileTraces(traces);
      const looped = r.programs.filter((p) => p.steps.some((s) => s.kind === "loop"));
      console.log(
        `holdout compile cart: programs=${r.programs.length} loops=${looped.length} \
seqs=${r.programs.map((p) => p.sequence.join("→")).join(" | ") || "(none)"} refusals=${r.refusals
          .map((x) => x.code ?? x.reason)
          .slice(0, 4)
          .join("; ")}`,
      );
      // Compiler already binds loop items on sku/qty (LOOP_ITEM_FIELDS). Pin the loop.
      expect(looped.length).toBeGreaterThanOrEqual(1);
      const over = looped[0]!.steps.find((s) => s.kind === "loop");
      expect(over && over.kind === "loop" && over.over).toMatchObject({ path: "items" });
      const body = looped[0]!.steps.find((s) => s.kind === "tool" && s.tool === "reserveSku");
      expect(body && body.kind === "tool" && body.args.sku).toEqual({
        kind: "from",
        step: "item_reserveSku_loop",
        path: "sku",
      });
    },
    TIMEOUT,
  );

  test(
    "unique-work (holdout-noise) compiles 0 programs",
    async () => {
      const goals = [...NOISE_IDS].slice(0, 4).map((id) => ({ id }));
      const traces = await recordN(createHoldoutNoise, goals, 4);
      const seqs = traces.map((t) => t.events.map((e) => e.name).join("→"));
      expect(new Set(seqs).size).toBe(seqs.length);
      const r = compileTraces(traces);
      expect(r.programs.length).toBe(0);
    },
    TIMEOUT,
  );
});

describe("holdout worlds: check() catches duplicated mutation", () => {
  test(
    "crm: poking createDeal twice fires duplicated",
    async () => {
      const w = createCrm();
      const tools = w.tools();
      await tools.createDeal!.execute({ leadId: "L-dup" });
      await tools.createDeal!.execute({ leadId: "L-dup" });
      const bad = w.check([{ leadId: "L-dup" }]);
      expect(bad.some((v) => v.includes("createDeal") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "calendar: poking createEvent twice fires duplicated",
    async () => {
      const w = createCalendar();
      const tools = w.tools();
      const slot = { when: CAL_SLOTS[0].when, title: CAL_SLOTS[0].title };
      await tools.createEvent!.execute(slot);
      await tools.createEvent!.execute(slot);
      const bad = w.check([slot]);
      expect(bad.some((v) => v.includes("createEvent") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "payments: poking createCharge twice fires duplicated",
    async () => {
      const w = createPayments();
      const tools = w.tools();
      await tools.createCharge!.execute({ email: PAY_EMAILS[0], invoiceId: "inv-x" });
      await tools.createCharge!.execute({ email: PAY_EMAILS[0], invoiceId: "inv-x" });
      const bad = w.check([{ email: PAY_EMAILS[0] }]);
      expect(bad.some((v) => v.includes("createCharge") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "cart: poking reserveSku twice for one sku fires duplicated",
    async () => {
      const w = createCart();
      const tools = w.tools();
      const cart = CART_IDS[0];
      const sku = skusFor(cart)[0]!;
      await tools.reserveSku!.execute({ sku });
      await tools.reserveSku!.execute({ sku });
      const bad = w.check([{ cart }]);
      expect(bad.some((v) => v.includes("reserveSku") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );
});

describe("holdout worlds: compileTraces → shadow goLive", () => {
  test("crm / calendar / payments / cart goLive PASS with a certified program", async () => {
    const cases: Array<{
      name: string;
      factory: () => World;
      goals: Array<Record<string, unknown>>;
    }> = [
      { name: "crm", factory: createCrm, goals: [...CRM_IDS].map((leadId) => ({ leadId })) },
      { name: "calendar", factory: createCalendar, goals: CAL_SLOTS.map((s) => ({ when: s.when, title: s.title })) },
      { name: "payments", factory: createPayments, goals: [...PAY_EMAILS].map((email) => ({ email })) },
      { name: "cart", factory: createCart, goals: [...CART_IDS].map((cart) => ({ cart })) },
    ];
    for (const c of cases) {
      const s = new Session([[c.name, c.factory]], true);
      for (let i = 0; i < 13; i++) {
        await s.stretch(c.name, c.goals[i % c.goals.length]!, blockSeed(`holdout-live-${c.name}-${i}`, i));
      }
      const r = await s.goLive(c.name, {
        compile: 9,
        holdout: 3,
        sandbox: c.factory,
        maxGram: 26,
      });
      expect(r.verdict, `${c.name} goLive ${r.verdict}: ${r.reasons.join("; ")}`).toBe("PASS");
      expect(r.program, `${c.name} program`).not.toBeNull();
      expect(r.program!.manifest?.certified).toBe(true);
      const live = new Session([[c.name, c.factory]], true);
      live.addPrograms([r.program!]);
      await live.stretch(c.name, c.goals[0]!, blockSeed(`holdout-serve-${c.name}`, 99));
      const fin = live.finish();
      expect(fin.violations, `${c.name} wrap serve ${fin.violations.join("; ")}`).toEqual([]);
      expect(fin.turns).toBe(1);
    }
  }, 60_000);
});
