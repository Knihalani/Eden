/**
 * Negative-control worlds: agent regimes where Eden's mechanism should NOT
 * help, or where its assumptions are actively violated. These exist to catch
 * overfitting — a benchmark suite built only of compilable stretches would
 * never notice Eden costing money on everything else.
 *
 *  - noise:    every stretch uses a DIFFERENT tool sequence (nothing to mine)
 *  - creative: every step is model judgment (all islands, nothing bindable)
 *  - micro:    two-call stretches (below compile minimum support)
 *  - fastdesk: desk shape but near-instant tools (think time dominates)
 *  - drift:    inputs walk away from the witnessed distribution mid-session
 *  - chaos:    incident world where most calls fail (failure-dominant)
 */
import type { IslandCaller } from "@eden/ir";
import { hashStr, type CallResult, type World } from "./worlds";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* noise — shuffled unique sequences. Nine tools; each stretch draws a */
/* different ordered subset, so no sequence ever reaches support 3.    */
/* ------------------------------------------------------------------ */

const NOISE_TOOLS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"] as const;

export function createNoise(): World {
  const done: Record<string, number> = {};
  const toolDefs = (): Record<
    string,
    { description: string; execute: (a: Record<string, unknown>) => Promise<unknown> }
  > => {
    const out: Record<string, { description: string; execute: (a: Record<string, unknown>) => Promise<unknown> }> = {};
    for (const name of NOISE_TOOLS) {
      out[name] = {
        description: `noise tool ${name}`,
        execute: async ({ id }) => {
          await Bun.sleep(30);
          return { name, id };
        },
      };
    }
    return out;
  };
  return {
    name: "noise",
    island: () => async () => ({ ok: false }),
    tools: toolDefs,
    async *script(goal) {
      const id = String(goal.id);
      // Deterministic per-goal shuffle: same goal always same order (so both
      // arms run identical work), different goals never share sequences.
      const rng = mulberry32(hashStr(id));
      const picks = [...NOISE_TOOLS].sort(() => rng() - 0.5).slice(0, 6);
      let last: CallResult | undefined;
      for (const tool of picks) {
        last = yield { tool, args: { id } };
      }
      void last;
    },
    done: () => false,
    terminal: "india",
    check() {
      return [];
    },
  };
}

/* ------------------------------------------------------------------ */
/* creative — every step is judgment. Five sequential islands; the     */
/* compiler has nothing bindable and steering has nothing to replay.   */
/* ------------------------------------------------------------------ */

export function createCreative(): World {
  const published: Record<string, number> = {};
  const island: IslandCaller =
    () =>
    async ({ input }) => {
      await Bun.sleep(60);
      return { text: `draft:${JSON.stringify(input).slice(0, 24)}` };
    };
  const judge = (name: string) => ({
    description: `${name} (model judgment)`,
    execute: async (args: Record<string, unknown>) => {
      await Bun.sleep(60);
      return { name, note: JSON.stringify(args).slice(0, 32) };
    },
  });
  return {
    name: "creative",
    island,
    tools: () => ({
      brief: judge("brief"),
      outline: judge("outline"),
      draftProse: judge("draftProse"),
      polish: judge("polish"),
      publishPost: {
        description: "Publish. Mutating.",
        execute: async ({ id }, ctx) => {
          await Bun.sleep(50);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          published[String(id)] = (published[String(id)] ?? 0) + 1;
          return { publishedId: String(id) };
        },
      },
    }),
    async *script(goal) {
      const id = String(goal.id);
      yield { tool: "brief", args: { id, topic: goal.topic } };
      yield { tool: "outline", args: { id } };
      yield { tool: "draftProse", args: { id } };
      yield { tool: "polish", args: { id } };
      const p = yield { tool: "publishPost", args: { id } };
      void p;
    },
    done: (v) => Boolean((v as { publishedId?: string })?.publishedId),
    terminal: "publishPost",
    check(doneGoals) {
      const occ = new Map<string, number>();
      for (const g of doneGoals) occ.set(String(g.id), (occ.get(String(g.id)) ?? 0) + 1);
      const bad: string[] = [];
      for (const [id, n] of occ) {
        if ((published[id] ?? 0) > n)
          bad.push(`creative:${id}: published ${published[id] ?? 0}x across ${n} stretch(es)`);
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* micro — two-call stretches. Below the compiler's minimum support    */
/* and below any useful reduction; pure recording overhead territory.  */
/* ------------------------------------------------------------------ */

export function createMicro(): World {
  const flags: Record<string, number> = {};
  return {
    name: "micro",
    island: () => async () => ({ ok: false }),
    tools: () => ({
      pingA: {
        description: "first call",
        execute: async ({ id }) => {
          await Bun.sleep(40);
          return { pong: true, id };
        },
      },
      setFlagB: {
        description: "second call. Mutating.",
        execute: async ({ id }, ctx) => {
          await Bun.sleep(30);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          flags[String(id)] = (flags[String(id)] ?? 0) + 1;
          return { flagged: true, id };
        },
      },
    }),
    async *script(goal) {
      const id = String(goal.id);
      yield { tool: "pingA", args: { id } };
      const f = yield { tool: "setFlagB", args: { id } };
      void f;
    },
    done: (v) => Boolean((v as { flagged?: boolean })?.flagged),
    terminal: "setFlagB",
    check(doneGoals) {
      const occ = new Map<string, number>();
      for (const g of doneGoals) occ.set(String(g.id), (occ.get(String(g.id)) ?? 0) + 1);
      const bad: string[] = [];
      for (const [id, n] of occ) {
        if ((flags[id] ?? 0) > n) bad.push(`micro:${id}: flag set ${flags[id] ?? 0}x across ${n} stretch(es)`);
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* fastdesk — the billing desk shape with near-instant local tools     */
/* (~1ms). Think time dominates; suppression can only save the tool    */
/* milliseconds, so wall-clock gains must come from turns alone.       */
/* ------------------------------------------------------------------ */

export function createFastDesk(): World {
  const credits: Record<string, number> = {};
  const emails: Record<string, number> = {};
  const accounts: Record<string, { mrr: number }> = {};
  for (const id of ["F-1", "F-2", "F-3", "F-4"]) accounts[id] = { mrr: 100 + id.length };
  const fast = (ms: number) => Bun.sleep(ms);
  return {
    name: "fastdesk",
    island:
      () =>
      async ({ input }) => {
        await fast(2);
        return { amount: 42 };
      },
    tools: () => ({
      getAccount: {
        description: "d",
        execute: async ({ id }) => {
          await fast(1);
          return accounts[String(id)] ?? { missing: true };
        },
      },
      listInvoices: {
        description: "d",
        execute: async () => {
          await fast(2);
          return { invoices: [] };
        },
      },
      classifyIssue: {
        description: "d",
        execute: async () => {
          await fast(1);
          return { category: "billing" };
        },
      },
      composeCredit: {
        description: "d",
        execute: async () => {
          await fast(3);
          return { amount: 42 };
        },
      },
      applyCredit: {
        description: "Mutating.",
        execute: async ({ id }, ctx) => {
          await fast(2);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          credits[String(id)] = (credits[String(id)] ?? 0) + 1;
          return { applied: true };
        },
      },
      auditWrite: {
        description: "Mutating.",
        execute: async ({ id }, ctx) => {
          await fast(1);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          return { audited: true };
        },
      },
      emailCustomer: {
        description: "Mutating.",
        execute: async ({ id }, ctx) => {
          await fast(2);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          emails[String(id)] = (emails[String(id)] ?? 0) + 1;
          return { emailed: true, id };
        },
      },
    }),
    async *script(goal) {
      const id = String(goal.id);
      yield { tool: "getAccount", args: { id } };
      yield { tool: "listInvoices", args: { id } };
      yield { tool: "classifyIssue", args: { id } };
      yield { tool: "composeCredit", args: { id } };
      yield { tool: "applyCredit", args: { id } };
      yield { tool: "auditWrite", args: { id } };
      const e = yield { tool: "emailCustomer", args: { id } };
      void e;
    },
    done: (v) => Boolean((v as { emailed?: boolean })?.emailed),
    terminal: "emailCustomer",
    fidelity: (events) => events.some((e) => e.name === "auditWrite" && e.ok),
    check(doneGoals) {
      const bad: string[] = [];
      for (const g of doneGoals) {
        if ((credits[String(g.id)] ?? 0) > 1) bad.push(`fastdesk:${g.id}: credit >1x`);
        if ((emails[String(g.id)] ?? 0) > 1) bad.push(`fastdesk:${g.id}: email >1x`);
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* chaos — incident triage where MOST calls fail (flakeP=0.55). The    */
/* naive arm burns retries; observe-mode Eden must neither halt nor    */
/* help; enforcement may stop the bleed. Failure-dominant regime.      */
/* ------------------------------------------------------------------ */

export function createChaos(): World {
  const inner = (() => {
    // Reuse the incident world's shape with an extreme flake rate.
    const filed: Record<string, number> = {};
    const paged: Record<string, number> = {};
    const attempts: Record<string, number> = {};
    const w: World = {
      name: "chaos",
      island:
        () =>
        async ({ input }) => {
          await Bun.sleep(50);
          return { rootCause: `cause:${JSON.stringify(input).slice(0, 20)}` };
        },
      tools: () => ({
        searchLogs: {
          description: "Search logs. Fails more often than not.",
          execute: async ({ q }) => {
            attempts[String(q)] = (attempts[String(q)] ?? 0) + 1;
            await Bun.sleep(25);
            if (attempts[String(q)]! % 3 !== 0) throw new Error("upstream timeout");
            return {
              events: Array.from({ length: 12 }, (_, i) => ({ lvl: i % 4 ? "info" : "error", msg: `${q} ${i}` })),
            };
          },
        },
        groupErrors: {
          description: "d",
          execute: async ({ events }) => {
            await Bun.sleep(15);
            const errs = Array.isArray(events) ? events.filter((e) => (e as { lvl?: string }).lvl === "error") : [];
            return { signature: `sig-${errs.length}` };
          },
        },
        fetchTrace: {
          description: "d",
          execute: async ({ signature }) => {
            await Bun.sleep(35);
            return { traceId: `tr-${String(signature).slice(4)}` };
          },
        },
        diagnose: {
          description: "Judgment.",
          execute: async () => {
            await Bun.sleep(60);
            return { rootCause: "overload" };
          },
        },
        fileIncident: {
          description: "Mutating.",
          execute: async ({ key }, ctx) => {
            await Bun.sleep(30);
            if (ctx?.signal?.aborted) throw new Error("aborted");
            filed[String(key)] = (filed[String(key)] ?? 0) + 1;
            return { filed: true };
          },
        },
        pageOnCall: {
          description: "Mutating.",
          execute: async ({ key }, ctx) => {
            await Bun.sleep(20);
            if (ctx?.signal?.aborted) throw new Error("aborted");
            paged[String(key)] = (paged[String(key)] ?? 0) + 1;
            return { paged: true, key };
          },
        },
      }),
      async *script(goal) {
        const key = String(goal.key);
        let logs: CallResult = yield { tool: "searchLogs", args: { q: key, key } };
        if (!logs.ok) logs = yield { tool: "searchLogs", args: { q: key, key } };
        if (!logs.ok) logs = yield { tool: "searchLogs", args: { q: key, key } }; // three tries, then give up
        if (!logs.ok) return;
        const grouped = yield {
          tool: "groupErrors",
          args: { events: (logs.value as { events?: unknown[] }).events ?? [] },
        };
        yield { tool: "fetchTrace", args: { signature: (grouped.value as { signature?: string }).signature } };
        yield { tool: "diagnose", args: {} };
        yield { tool: "fileIncident", args: { key } };
        const p = yield { tool: "pageOnCall", args: { key } };
        void p;
      },
      done: (v) => Boolean((v as { paged?: boolean })?.paged),
      terminal: "pageOnCall",
      fidelity: (events) => events.every((e) => e.ok),
      check(doneGoals) {
        const occ = new Map<string, number>();
        for (const g of doneGoals) occ.set(String(g.key), (occ.get(String(g.key)) ?? 0) + 1);
        const bad: string[] = [];
        for (const [k, n] of occ) {
          if ((filed[k] ?? 0) > n) bad.push(`chaos:${k}: filed ${filed[k] ?? 0}x across ${n} stretch(es)`);
          if ((paged[k] ?? 0) > n) bad.push(`chaos:${k}: paged ${paged[k] ?? 0}x across ${n} stretch(es)`);
        }
        return bad;
      },
    };
    return w;
  })();
  return inner;
}
