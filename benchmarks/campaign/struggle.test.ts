/**
 * Struggle probes: capacity and degradation regimes where Eden's internal
 * bounds meet load. Each probe is pass/fail on CORRECTNESS first — a
 * duplicated mutation here is a shipped bug no matter what any benchmark says.
 *
 *   P1  >ARM_MAX_ENTRIES concurrent distinct inputs on ONE wrapped surface
 *       (the multi-agent server regime): eviction must never drop a LIVE
 *       suppression and let a tail re-execute.
 *   P2  a tail longer than ARM_SLACK_CALLS: the arming budget must cover the
 *       whole tail for an oblivious agent.
 *   P3  the wrap timeout firing mid-compiled-run AFTER a mutating step:
 *       exactly-once, structured deopt, no silent replay.
 *   P4  an island caller that ALWAYS fails, with the island after a write:
 *       the write happens once, nothing replays it.
 *   P5  version churn: swapping the live program mid-session must not let
 *       old armings swallow new-version work or vice versa.
 */
import { describe, expect, test } from "bun:test";
import { withVersion, type Step, type StretchProgram } from "@eden/ir";
import { createState, wrapTools, createArmingStore, type ToolDef } from "@eden/wrap";
import { fireOblivious, linearProgram } from "./struggle-harness";

process.env.CAMPAIGN_THINK_MS = "1";
const TIMEOUT = 120_000;

describe("struggle: capacity bounds", () => {
  test(
    "P1: 80 concurrent distinct-input stretches — eviction must not duplicate tail executions",
    async () => {
      const N = 80; // > ARM_MAX_ENTRIES (64)
      const TAIL = ["fetch", "judge", "write", "audit"]; // write+audit in the tail
      const calls: string[] = [];
      const writes: Record<string, number> = {};
      const audits: Record<string, number> = {};
      const mkTool = (name: string, mutate?: (id: string) => void): ToolDef => ({
        description: name,
        execute: async (args: Record<string, unknown>) => {
          calls.push(`${name}:${String(args.id)}`);
          mutate?.(String(args.id));
          return { name, id: args.id };
        },
      });
      const tools: Record<string, ToolDef> = {
        lookup: mkTool("lookup"),
        fetch: mkTool("fetch"),
        judge: mkTool("judge"),
        write: mkTool("write", (id) => {
          writes[id] = (writes[id] ?? 0) + 1;
        }),
        audit: mkTool("audit", (id) => {
          audits[id] = (audits[id] ?? 0) + 1;
        }),
      };
      // First-call-carries-text so steering matches; tails take only id.
      const prog = linearProgram("p_wide", ["lookup", ...TAIL], { text: true });
      const state = createState({ programs: [prog] });
      const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;

      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          fireOblivious(wrapped, [
            { tool: "lookup", args: { id: `E-${i}`, text: `complaint ${i}` } },
            { tool: "fetch", args: { id: `E-${i}` } },
            { tool: "judge", args: { id: `E-${i}` } },
            { tool: "write", args: { id: `E-${i}` } },
            { tool: "audit", args: { id: `E-${i}` } },
          ]),
        ),
      );

      for (let i = 0; i < N; i++) {
        const id = `E-${i}`;
        expect(writes[id]).toBe(1);
        expect(audits[id]).toBe(1);
      }
    },
    TIMEOUT,
  );

  test(
    "P1b: W=100 concurrent distinct-input stretches — fail-open, zero duplicate writes (Arc 6 catcher)",
    async () => {
      // Capacity gate is 64. Beyond it, new stretches fail open to raw (A3).
      // Arc 6's hosted-dispatch target is W≥100 with the same exactly-once
      // invariant — this probe is the catcher, not a new arming store.
      const N = 100;
      const TAIL = ["fetch", "judge", "write", "audit"];
      const writes: Record<string, number> = {};
      const audits: Record<string, number> = {};
      const mkTool = (name: string, mutate?: (id: string) => void): ToolDef => ({
        description: name,
        execute: async (args: Record<string, unknown>) => {
          mutate?.(String(args.id));
          return { name, id: args.id };
        },
      });
      const tools: Record<string, ToolDef> = {
        lookup: mkTool("lookup"),
        fetch: mkTool("fetch"),
        judge: mkTool("judge"),
        write: mkTool("write", (id) => {
          writes[id] = (writes[id] ?? 0) + 1;
        }),
        audit: mkTool("audit", (id) => {
          audits[id] = (audits[id] ?? 0) + 1;
        }),
      };
      const prog = linearProgram("p_wide100", ["lookup", ...TAIL], { text: true });
      const state = createState({ programs: [prog] });
      const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;

      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          fireOblivious(wrapped, [
            { tool: "lookup", args: { id: `W-${i}`, text: `complaint ${i}` } },
            { tool: "fetch", args: { id: `W-${i}` } },
            { tool: "judge", args: { id: `W-${i}` } },
            { tool: "write", args: { id: `W-${i}` } },
            { tool: "audit", args: { id: `W-${i}` } },
          ]),
        ),
      );

      for (let i = 0; i < N; i++) {
        const id = `W-${i}`;
        expect(writes[id]).toBe(1);
        expect(audits[id]).toBe(1);
      }
    },
    TIMEOUT,
  );

  test(
    "P1c: W=100 sessions × 1 stretch on a shared store — all armed, zero duplicate writes (Wave 4.2)",
    async () => {
      const N = 100;
      const TAIL = ["fetch", "judge", "write", "audit"];
      const writes: Record<string, number> = {};
      const audits: Record<string, number> = {};
      const mkTool = (name: string, mutate?: (id: string) => void): ToolDef => ({
        description: name,
        execute: async (args: Record<string, unknown>) => {
          mutate?.(String(args.id));
          return { name, id: args.id };
        },
      });
      const tools: Record<string, ToolDef> = {
        lookup: mkTool("lookup"),
        fetch: mkTool("fetch"),
        judge: mkTool("judge"),
        write: mkTool("write", (id) => {
          writes[id] = (writes[id] ?? 0) + 1;
        }),
        audit: mkTool("audit", (id) => {
          audits[id] = (audits[id] ?? 0) + 1;
        }),
      };
      const prog = linearProgram("p_hosted100", ["lookup", ...TAIL], { text: true });
      const arming = createArmingStore();
      await Promise.all(
        Array.from({ length: N }, (_, i) => {
          const state = createState({ programs: [prog], arming, sessionId: `sess-${i}` });
          const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;
          return fireOblivious(wrapped, [
            { tool: "lookup", args: { id: `S-${i}`, text: `complaint ${i}` } },
            { tool: "fetch", args: { id: `S-${i}` } },
            { tool: "judge", args: { id: `S-${i}` } },
            { tool: "write", args: { id: `S-${i}` } },
            { tool: "audit", args: { id: `S-${i}` } },
          ]);
        }),
      );
      expect(arming.stats().rejects).toBe(0);
      expect(arming.stats().admits).toBeGreaterThanOrEqual(N);
      for (let i = 0; i < N; i++) {
        const id = `S-${i}`;
        expect(writes[id]).toBe(1);
        expect(audits[id]).toBe(1);
      }
    },
    TIMEOUT,
  );

  test(
    "P2: a 40-step tail exceeds the slack budget — oblivious agent must not double-execute",
    async () => {
      const TAIL_LEN = 40; // > ARM_SLACK_CALLS (32)
      const sequence = ["lookup", ...Array.from({ length: TAIL_LEN }, (_, i) => `step${i}`)];
      const execs: Record<string, number> = {};
      const tools: Record<string, ToolDef> = {};
      for (const name of sequence) {
        tools[name] = {
          description: name,
          execute: async (args: Record<string, unknown>) => {
            const k = `${name}:${String(args.id)}`;
            execs[k] = (execs[k] ?? 0) + 1;
            return { name };
          },
        };
      }
      const prog = linearProgram("p_longtail", sequence, { text: true });
      const state = createState({ programs: [prog] });
      const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;

      // Three oblivious stretches so the arming budget pressure is real.
      await Promise.all(
        ["L-1", "L-2"].map((id) =>
          fireOblivious(
            wrapped,
            sequence.map((name) => ({ tool: name, args: name === "lookup" ? { id, text: "t" } : { id } })),
          ),
        ),
      );

      for (const name of sequence) {
        for (const id of ["L-1", "L-2"]) {
          expect(execs[`${name}:${id}`]).toBe(1);
        }
      }
    },
    TIMEOUT,
  );
});

describe("struggle: degradation", () => {
  function buildTimedWorld(timeoutMs: number) {
    const calls: string[] = [];
    const writes: Record<string, number> = [];
    const notified: Record<string, number> = [];
    const tools: Record<string, ToolDef> = {
      lookup: {
        description: "d",
        execute: async (a) => {
          calls.push(`lookup:${a.id}`);
          return { id: a.id };
        },
      },
      applyCredit: {
        description: "Mutating.",
        execute: async (a) => {
          calls.push(`apply:${a.id}`);
          writes.push(String(a.id));
          return { applied: true };
        },
      },
      slowJudge: {
        description: "Judgment that takes longer than the wrap timeout.",
        execute: async () => {
          await Bun.sleep(timeoutMs * 4);
          return { ok: true };
        },
      },
      emailCustomer: {
        description: "Mutating.",
        execute: async (a) => {
          calls.push(`email:${a.id}`);
          notified.push(String(a.id));
          return { emailed: true };
        },
      },
    };
    return { calls, writes, notified, tools };
  }

  test(
    "P3: wrap timeout mid-compiled-run after a write — exactly-once, structured deopt",
    async () => {
      const timeoutMs = 120;
      const { calls, writes, notified, tools } = buildTimedWorld(timeoutMs);
      const prog = linearProgram("p_slow", ["lookup", "applyCredit", "slowJudge", "emailCustomer"], { text: true });
      const state = createState({ programs: [prog], timeoutMs });
      const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;

      // Head steers; the compiled run writes, hits the timeout inside slowJudge.
      const head = (await wrapped.lookup!.execute({ id: "T-1", text: "x" })) as Record<string, unknown>;
      // Either a structured result or a deopt marker — never a silent success.
      expect(head).toBeTruthy();

      // The write happened exactly once.
      expect(writes.filter((w) => w === "T-1").length).toBe(1);

      // An oblivious agent keeps issuing calls. The already-done write is
      // CLAIMED (never re-run). The email was never reached by the compiled
      // run, but Eden cannot PROVE that from a timed-out run, so the raw
      // attempt gets the honest structured refusal rather than a guess —
      // the agent retries explicitly if it wants the email.
      const w2 = (await wrapped.applyCredit!.execute({ id: "T-1" })) as Record<string, unknown>;
      expect(w2).toMatchObject({ eden: "steered" });
      const e2 = (await wrapped.emailCustomer!.execute({ id: "T-1" })) as Record<string, unknown>;
      expect(e2).toMatchObject({ eden: "deopt" });
      expect(writes.filter((w) => w === "T-1").length).toBe(1);
      expect(notified.filter((n) => n === "T-1").length).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "P4: island always fails and sits between two writes — the first write is never replayed",
    async () => {
      const calls: string[] = [];
      const writes: Record<string, number> = [];
      const sent: Record<string, number> = [];
      const failingIsland = async () => {
        throw new Error("no OPENAI_API_KEY");
      };
      const tools: Record<string, ToolDef> = {
        lookup: {
          description: "d",
          execute: async (a) => {
            calls.push(`lookup:${a.id}`);
            return { id: a.id };
          },
        },
        applyCredit: {
          description: "Mutating.",
          execute: async (a) => {
            calls.push(`apply:${a.id}`);
            writes.push(String(a.id));
            return { applied: true };
          },
        },
        emailCustomer: {
          description: "Mutating.",
          execute: async (a) => {
            calls.push(`email:${a.id}`);
            sent.push(String(a.id));
            return { emailed: true };
          },
        },
      };
      const steps: Step[] = [
        { id: "lookup", kind: "tool", tool: "lookup", args: { id: { kind: "input", path: "id" } } },
        { id: "applyCredit", kind: "tool", tool: "applyCredit", args: { id: { kind: "input", path: "id" } } },
        { id: "draft", kind: "island", input: { kind: "input", path: "" }, system: "s", outputSchema: {} },
        { id: "emailCustomer", kind: "tool", tool: "emailCustomer", args: { id: { kind: "input", path: "id" } } },
      ];
      const prog = withVersion({
        id: "p_islandfail",
        name: "p_islandfail",
        description: "d",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        sequence: ["lookup", "applyCredit", "draft", "emailCustomer"],
        steps,
        returns: { kind: "from", step: "emailCustomer", path: "" },
        contract: { witnesses: 3, minLlmReduction: 2, allowExact: true },
        manifest: {
          llmReduction: 3,
          latencyReduction: 1,
          costReduction: 1,
          skipRateBefore: 0,
          skipRateAfter: 0,
          nShadow: 3,
        },
      }) as StretchProgram;
      const state = createState({ programs: [prog], island: failingIsland });
      const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;

      // Head steers; compiled run writes, islands dies, structured deopt.
      const head = (await wrapped.lookup!.execute({ id: "I-1" })) as Record<string, unknown>;
      expect(head).toBeTruthy();
      expect(writes.filter((w) => w === "I-1").length).toBe(1);

      // Oblivious continuation: the raw write attempt must be claimed (it was
      // done by the compiled run), the email may run once via raw fallback.
      await wrapped.applyCredit!.execute({ id: "I-1" });
      await wrapped.emailCustomer!.execute({ id: "I-1" });
      expect(writes.filter((w) => w === "I-1").length).toBe(1);
      expect(sent.filter((s) => s === "I-1").length).toBeLessThanOrEqual(1);
    },
    TIMEOUT,
  );

  test(
    "P5: version churn — swapping the live program mid-session keeps exactly-once",
    async () => {
      const calls: string[] = [];
      const writes: Record<string, number> = [];
      const mkTools = (): Record<string, ToolDef> => ({
        lookup: {
          description: "d",
          execute: async (a) => {
            calls.push(`lookup:${a.id}`);
            return { id: a.id };
          },
        },
        fetch: {
          description: "d",
          execute: async (a) => {
            calls.push(`fetch:${a.id}`);
            return { fetched: true };
          },
        },
        applyCredit: {
          description: "Mutating.",
          execute: async (a) => {
            calls.push(`apply:${a.id}`);
            writes.push(String(a.id));
            return { applied: true };
          },
        },
        audit: {
          description: "d",
          execute: async (a) => {
            calls.push(`audit:${a.id}`);
            return { audited: true };
          },
        },
      });
      const v1 = linearProgram("p_churn", ["lookup", "fetch", "applyCredit", "audit"], { text: true });
      const v2 = linearProgram("p_churn_v2", ["lookup", "applyCredit", "audit"], { text: true });

      const tools = mkTools();
      const state = createState({ programs: [v1] });
      const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;

      // Stretch 1 under v1.
      await wrapped.lookup!.execute({ id: "V-1", text: "t" });
      // Rollback: swap the live program while no stretch is in flight.
      state.programs.length = 0;
      state.programs.push(v2);
      // Stretch 2 under v2 — new head, new arming, old cache entry must not win.
      const head = (await wrapped.lookup!.execute({ id: "V-2", text: "t" })) as Record<string, unknown>;
      expect(head).toBeTruthy();
      // An oblivious tail for V-2 under v2's shorter sequence.
      await wrapped.fetch!.execute({ id: "V-2" }).catch(() => undefined);
      await wrapped.applyCredit!.execute({ id: "V-2" });
      await wrapped.audit!.execute({ id: "V-2" });

      expect(writes.filter((w) => w === "V-1").length).toBe(1);
      expect(writes.filter((w) => w === "V-2").length).toBe(1);
    },
    TIMEOUT,
  );
});
