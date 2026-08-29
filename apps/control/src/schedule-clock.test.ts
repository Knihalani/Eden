import { describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import { registryFrom } from "@eden/runtime";
import { scheduleClockEnabled, startScheduleClock } from "./schedule-clock";
import { tickDueSchedules } from "./schedule";
import { Store } from "./store";

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
    budget: { llmCalls: 0, ms: 1_000, cents: 0 },
  };
}

function putLive(store: Store, id: string, state: "live" | "paused" = "live"): void {
  const program = literalProgram(id);
  store.putTool({
    id,
    name: id,
    version: program.version,
    program,
    state,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

describe("schedule clock", () => {
  test("EDEN_SCHEDULE_CLOCK=0 is off; unset is on", () => {
    expect(scheduleClockEnabled("0")).toBe(false);
    expect(scheduleClockEnabled(undefined)).toBe(true);
    expect(scheduleClockEnabled("1")).toBe(true);
  });

  test("tickDueSchedules fires live and never paused; same minute does not double-fire", async () => {
    const store = new Store(":memory:");
    putLive(store, "wf_clock");
    putLive(store, "wf_paused_clock", "paused");
    store.putSchedule({
      id: "sch_clock",
      tool_id: "wf_clock",
      cron: "* * * * *",
      input: null,
      last_tick: null,
      created_at: Date.now(),
    });
    store.putSchedule({
      id: "sch_paused",
      tool_id: "wf_paused_clock",
      cron: "* * * * *",
      input: null,
      last_tick: null,
      created_at: Date.now(),
    });

    const registry = registryFrom({});
    const now = new Date("2026-08-29T14:30:00Z");
    const first = await tickDueSchedules({ store, registry, timeoutMs: 5_000, now });
    expect(first.fired).toBe(1);
    expect(first.paused).toBe(1);
    expect(store.receiptsFor("wf_clock")).toHaveLength(1);
    expect(store.receiptsFor("wf_paused_clock")).toHaveLength(0);

    const again = await tickDueSchedules({ store, registry, timeoutMs: 5_000, now });
    expect(again.fired).toBe(0);
    expect(store.receiptsFor("wf_clock")).toHaveLength(1);
  });

  test("startScheduleClock ticks a due live tool then stop", async () => {
    const store = new Store(":memory:");
    putLive(store, "wf_interval");
    store.putSchedule({
      id: "sch_interval",
      tool_id: "wf_interval",
      cron: "* * * * *",
      input: null,
      last_tick: null,
      created_at: Date.now(),
    });
    const { stop, intervalMs } = startScheduleClock({ store, registry: registryFrom({}) }, { intervalMs: 15 });
    expect(intervalMs).toBe(15);
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(store.receiptsFor("wf_interval").length).toBeGreaterThanOrEqual(1);
  });
});
