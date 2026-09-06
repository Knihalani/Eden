/**
 * Wave 4.4 CI pin: timeout sweep keeps exactly-once; default is the justified 60s.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_WRAP_TIMEOUT_MS, wrapTimeoutMs } from "@eden/wrap";
import { createState, wrapTools, type ToolDef } from "@eden/wrap";
import { linearProgram } from "./struggle-harness";

describe("timeout regime (Wave 4.4)", () => {
  test("default is 60s and honors EDEN_TIMEOUT_MS", () => {
    expect(DEFAULT_WRAP_TIMEOUT_MS).toBe(60_000);
    const prev = process.env.EDEN_TIMEOUT_MS;
    delete process.env.EDEN_TIMEOUT_MS;
    expect(wrapTimeoutMs()).toBe(60_000);
    if (prev === undefined) delete process.env.EDEN_TIMEOUT_MS;
    else process.env.EDEN_TIMEOUT_MS = prev;
  });

  test("timeout < slowJudge: deopt-claim, write once, email not duplicated", async () => {
    const timeoutMs = 40;
    const writes: string[] = [];
    const notified: string[] = [];
    const tools: Record<string, ToolDef> = {
      lookup: { description: "d", execute: async (a) => ({ id: a.id }) },
      applyCredit: {
        description: "m",
        execute: async (a) => {
          writes.push(String(a.id));
          return { applied: true };
        },
      },
      slowJudge: {
        description: "slow",
        execute: async () => {
          await Bun.sleep(timeoutMs * 4);
          return { ok: true };
        },
      },
      emailCustomer: {
        description: "m",
        execute: async (a) => {
          notified.push(String(a.id));
          return { emailed: true };
        },
      },
    };
    const prog = linearProgram("p_to", ["lookup", "applyCredit", "slowJudge", "emailCustomer"], { text: true });
    const wrapped = wrapTools(tools, createState({ programs: [prog], timeoutMs })) as Record<string, ToolDef>;
    await wrapped.lookup!.execute({ id: "T-1", text: "x" });
    const w2 = (await wrapped.applyCredit!.execute({ id: "T-1" })) as Record<string, unknown>;
    expect(w2).toMatchObject({ eden: "steered" });
    const e2 = (await wrapped.emailCustomer!.execute({ id: "T-1" })) as Record<string, unknown>;
    expect(e2).toMatchObject({ eden: "deopt" });
    expect(writes.filter((x) => x === "T-1")).toHaveLength(1);
    expect(notified.filter((x) => x === "T-1")).toHaveLength(0);
  });

  test("timeout > slowJudge: compiled completes, write once, email once", async () => {
    const writes: string[] = [];
    const notified: string[] = [];
    const tools: Record<string, ToolDef> = {
      lookup: { description: "d", execute: async (a) => ({ id: a.id }) },
      applyCredit: {
        description: "m",
        execute: async (a) => {
          writes.push(String(a.id));
          return { applied: true };
        },
      },
      slowJudge: { description: "fast enough", execute: async () => ({ ok: true }) },
      emailCustomer: {
        description: "m",
        execute: async (a) => {
          notified.push(String(a.id));
          return { emailed: true };
        },
      },
    };
    const prog = linearProgram("p_ok", ["lookup", "applyCredit", "slowJudge", "emailCustomer"], { text: true });
    const wrapped = wrapTools(tools, createState({ programs: [prog], timeoutMs: 8_000 })) as Record<string, ToolDef>;
    await wrapped.lookup!.execute({ id: "T-2", text: "x" });
    expect(writes.filter((x) => x === "T-2")).toHaveLength(1);
    expect(notified.filter((x) => x === "T-2")).toHaveLength(1);
  });
});
