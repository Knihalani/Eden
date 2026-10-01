/**
 * Campaign worlds: five agent domains with different waste shapes.
 *
 * Deliberately NOT the TicketShip fixture — that one already has dedicated
 * benches. These exist to answer a question the fixture cannot: does Eden
 * help across heterogeneous, realistic workloads, on short sessions and long
 * ones, without ever corrupting state?
 *
 * Every world shares one contract:
 *   - `tools()` hands out fresh tool defs bound to this world's state,
 *   - `script(goal)` returns the agent's behaviour for one stretch as an
 *     async generator: yield a call, receive its result, decide whether the
 *     goal is already satisfied,
 *   - `check()` lists correctness violations (missing or duplicated
 *     mutations, wrong values) after a session ran.
 *
 * Latencies are small but real sleeps, so wall-clock numbers mean something.
 */
import type { IslandCaller } from "@eden/ir";
import { mulberry32 } from "@eden/measure";

export type CallResult = { ok: true; value: unknown } | { ok: false; error: unknown };

export type World = {
  name: string;
  /** Fresh tool surface bound to this world's state. */
  tools(): Record<
    string,
    { description: string; execute: (args: Record<string, unknown>) => Promise<unknown> | unknown }
  >;
  /** The cheap-model caller compiled islands use. Counts invocations on the world. */
  island(): IslandCaller;
  /** One agent stretch: yields (tool,args), receives results, stops when done. */
  script(
    goal: Record<string, unknown>,
    rng: () => number,
  ): AsyncGenerator<{ tool: string; args: Record<string, unknown> }, void, CallResult>;
  /** True when this result means the stretch's goal is fully satisfied — the
   * point at which a competent agent stops issuing calls. Under steering the
   * very first call returns this shape; raw arms only reach it on the last call. */
  done(value: unknown): boolean;
  /** The final tool of the scripted stretch; completing it means the goal was
   * reached even when the agent does not early-stop (oblivious mode). */
  terminal: string;
  /** Optional: reset per-stretch world state (e.g. first-attempt flakes). */
  beginStretch?: () => void;
  /** Optional full-fidelity predicate: true when this trace is a complete,
   * non-degraded witness of the stretch (no skipped steps, no retries).
   * Defaults to "all traces qualify". Used to pick compile/hold-out splits —
   * length alone cannot distinguish a sloppy variant from a legitimately
   * different fan-out width. */
  fidelity?: (events: Array<{ name: string; ok: boolean }>) => boolean;
  /** Correctness violations after a session. Empty means the world is consistent. */
  check(doneGoals: Array<Record<string, unknown>>): string[];
};

const THINK_NOTE = "agent think time is charged by the driver, not the world";

function ok(v: unknown): CallResult {
  return { ok: true, value: v };
}

/**
 * Monotonic per-process call ordinal folded into read payloads.
 *
 * Real tool results carry live data — timestamps, counts, fresh quotes — so
 * two stretches against the same entity never record byte-identical payloads.
 * A deterministic simulator that repeats payloads verbatim collides with
 * trace de-duplication (identical witnesses hash to one trace), which quietly
 * halves the evidence base. The ordinal restores realistic variance.
 */
let ord = 0;
function nextOrd(): number {
  return ++ord;
}

/** Deterministic per-block seed shared by both arms, so flakes pair up. */
export function blockSeed(task: string, repeat: number): number {
  let h = 2166136261 >>> 0;
  const s = `${task}:${repeat}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Correctness under cycling goals: one stretch of an entity may legitimately
 * mutate it once per session (long sessions revisit pool ids), so the only
 * real violations are DUPLICATION (more mutations than stretches) or
 * impossible counts.
 */
function occurrences(goals: Array<Record<string, unknown>>, key: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of goals) {
    const k = String(g[key]);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function dupCheck(
  label: string,
  goals: Array<Record<string, unknown>>,
  key: string,
  counters: Array<{ name: string; get: (id: string) => number }>,
): string[] {
  const bad: string[] = [];
  const occ = occurrences(goals, key);
  for (const [id, n] of occ) {
    for (const c of counters) {
      const got = c.get(id);
      if (got > n) bad.push(`${label}:${id}: ${c.name} ran ${got}x across ${n} stretch(es) — duplicated`);
    }
  }
  return bad;
}

/* ------------------------------------------------------------------ */
/* World 1 — billing desk: linear 7-call stretch, mutating tail,      */
/* one judgment step, one step sloppy agents skip 15% of the time.    */
/* ------------------------------------------------------------------ */

export const DESK_IDS = ["A-2001", "A-2002", "A-2003", "A-2004"] as const;

type DeskState = {
  credits: Map<string, number>;
  audits: Map<string, number>;
  emails: Map<string, number>;
  islands: number;
};

export function createDesk(): World {
  const st: DeskState = { credits: new Map(), audits: new Map(), emails: new Map(), islands: 0 };
  const accounts: Record<string, { name: string; plan: string; mrr: number }> = {};
  for (const id of DESK_IDS)
    accounts[id] = { name: `Acct ${id}`, plan: id.endsWith("4") ? "scale" : "pro", mrr: 400 + id.length * 97 };
  return {
    name: "desk",
    island:
      () =>
      async ({ input, signal }) => {
        st.islands++;
        await Bun.sleep(200);
        if (signal?.aborted) throw new Error("aborted");
        const f = (input ?? {}) as Record<string, unknown>;
        return { amount: Math.min(5000, Number(f.mrr ?? 100) >> 3), note: `credit for ${f.category ?? "general"}` };
      },
    tools: () => ({
      getAccount: {
        description: "Fetch an account by id.",
        execute: async ({ id }) => {
          await Bun.sleep(40);
          return accounts[String(id)] ?? { missing: true, id };
        },
      },
      listInvoices: {
        description: "List recent invoices.",
        execute: async ({ id }) => {
          await Bun.sleep(60);
          return {
            invoices: Array.from({ length: 5 }, (_, i) => ({ n: i, cents: 2900 + i * 131, overdue: i === 2 })),
            seq: nextOrd(),
          };
        },
      },
      classifyIssue: {
        description: "Classify the complaint text.",
        execute: async ({ text }) => {
          await Bun.sleep(30);
          return { category: String(text ?? "").includes("refund") ? "billing" : "general" };
        },
      },
      composeCredit: {
        description: "Judge the right credit amount. Model judgment.",
        execute: async (args) => {
          await Bun.sleep(225);
          const mrr = Number((args as Record<string, unknown>).mrr ?? 300);
          return { amount: Math.min(5000, mrr >> 3) };
        },
      },
      applyCredit: {
        description: "Apply a service credit. Mutating.",
        execute: async ({ id, amount }) => {
          await Bun.sleep(50);
          st.credits.set(String(id), (st.credits.get(String(id)) ?? 0) + 1);
          return { applied: true, id, amount };
        },
      },
      auditWrite: {
        description: "Record an audit line for the credit. Required by policy.",
        execute: async ({ id }) => {
          await Bun.sleep(35);
          st.audits.set(String(id), (st.audits.get(String(id)) ?? 0) + 1);
          return { audited: true, id };
        },
      },
      emailCustomer: {
        description: "Email the customer. Mutating.",
        execute: async ({ id }) => {
          await Bun.sleep(45);
          st.emails.set(String(id), (st.emails.get(String(id)) ?? 0) + 1);
          return { emailed: true, id };
        },
      },
    }),
    async *script(goal, rng) {
      const id = String(goal.id);
      const text = String(goal.text ?? "requesting refund for outage");
      // First call carries the full goal context (id + complaint text):
      // steering recovers the program's input from sequence[0] args, and the
      // compiled program's input includes the complaint text.
      const acct = yield { tool: "getAccount", args: { id, text } };
      const inv = yield { tool: "listInvoices", args: { id } };
      const cls = yield { tool: "classifyIssue", args: { text: goal.text ?? "requesting refund for outage" } };
      const credit = yield {
        tool: "composeCredit",
        args: {
          id,
          mrr: (acct.value as { mrr?: number })?.mrr ?? 300,
          category: (cls.value as { category?: string })?.category,
        },
      };
      yield { tool: "applyCredit", args: { id, amount: (credit.value as { amount?: number })?.amount ?? 100 } };
      // Sloppy agents skip the audit line 15% of the time. Seeded, so both
      // arms see the same sloppiness on the same block.
      if (rng() >= 0.15) yield { tool: "auditWrite", args: { id } };
      const last = inv; // keep the generator honest: result consumed above
      void last;
      const emailed = yield { tool: "emailCustomer", args: { id } };
      void emailed;
    },
    done: (v) => Boolean((v as { emailed?: boolean })?.emailed),
    terminal: "emailCustomer",
    fidelity: (events) => events.some((e) => e.name === "auditWrite" && e.ok),
    check(doneGoals) {
      return dupCheck("desk", doneGoals, "id", [
        { name: "applyCredit", get: (id) => st.credits.get(id) ?? 0 },
        { name: "emailCustomer", get: (id) => st.emails.get(id) ?? 0 },
        { name: "auditWrite", get: (id) => st.audits.get(id) ?? 0 },
      ]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* World 2 — orders: fan-out inventory checks (3..12 items), then a   */
/* mutating refund pipeline. Loop shape, varying width.               */
/* ------------------------------------------------------------------ */

export const ORDER_IDS = ["O-7001", "O-7002", "O-7003", "O-7004"] as const;

type OrderState = { refunds: Map<string, number>; restocks: Map<string, number>; receipts: Map<string, number> };

export function createOrders(): World {
  const st: OrderState = { refunds: new Map(), restocks: new Map(), receipts: new Map() };
  const itemsFor = (seededRng: () => number) =>
    Array.from({ length: 3 + Math.floor(seededRng() * 10) }, (_, i) => `SKU-${1000 + i}`);
  return {
    name: "orders",
    island: () => async () => ({ ok: false }),
    tools: () => ({
      findOrder: {
        description: "Find an order and its items.",
        execute: async ({ orderId }, ctx) => {
          await Bun.sleep(50);
          const rng = mulberry32(hashStr(String(orderId)));
          return { orderId, items: itemsFor(rng), paid: true };
        },
      },
      checkInventory: {
        description: "Check stock for one item.",
        execute: async ({ itemId }) => {
          await Bun.sleep(75);
          return { itemId, inStock: true, qty: 1 + (nextOrd() % 9) };
        },
      },
      computeRefund: {
        description: "Compute the refund owed.",
        execute: async ({ orderId, items }) => {
          await Bun.sleep(40);
          return { orderId, cents: 4200 + (Array.isArray(items) ? items.length : 0) * 311 };
        },
      },
      issueRefund: {
        description: "Issue the refund. Mutating.",
        execute: async ({ orderId }, ctx) => {
          await Bun.sleep(60);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          st.refunds.set(String(orderId), (st.refunds.get(String(orderId)) ?? 0) + 1);
          return { refunded: true, orderId };
        },
      },
      restockItems: {
        description: "Return items to stock. Mutating.",
        execute: async ({ orderId }, ctx) => {
          await Bun.sleep(70);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          st.restocks.set(String(orderId), (st.restocks.get(String(orderId)) ?? 0) + 1);
          return { restocked: true, orderId };
        },
      },
      sendReceipt: {
        description: "Send the receipt. Mutating.",
        execute: async ({ orderId }, ctx) => {
          await Bun.sleep(45);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          st.receipts.set(String(orderId), (st.receipts.get(String(orderId)) ?? 0) + 1);
          return { receiptSent: true, orderId };
        },
      },
    }),
    async *script(goal, _rng) {
      const orderId = String(goal.orderId);
      const found = yield { tool: "findOrder", args: { orderId } };
      const items = (found.value as { items?: string[] }).items ?? [];
      for (const it of items) {
        yield { tool: "checkInventory", args: { itemId: it, orderId } };
      }
      const refund = yield { tool: "computeRefund", args: { orderId, items } };
      yield { tool: "issueRefund", args: { orderId, cents: (refund.value as { cents?: number })?.cents } };
      yield { tool: "restockItems", args: { orderId } };
      const sent = yield { tool: "sendReceipt", args: { orderId } };
      void sent;
    },
    done: (v) => Boolean((v as { receiptSent?: boolean })?.receiptSent),
    terminal: "sendReceipt",
    check(doneGoals) {
      return dupCheck("orders", doneGoals, "orderId", [
        { name: "issueRefund", get: (id) => st.refunds.get(id) ?? 0 },
        { name: "sendReceipt", get: (id) => st.receipts.get(id) ?? 0 },
        { name: "restockItems", get: (id) => st.restocks.get(id) ?? 0 },
      ]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* World 3 — etl: nightly report over eight sources, fat payloads.    */
/* Pure read fan-out into one mutating write + verify.                */
/* ------------------------------------------------------------------ */

export function createEtl(sourceCount = 8): World {
  const reports = new Map<string, number>();
  return {
    name: "etl",
    island: () => async () => ({ ok: false }),
    tools: () => ({
      listSources: {
        description: "List upstream sources for the run.",
        execute: async () => {
          await Bun.sleep(40);
          return { sources: Array.from({ length: sourceCount }, (_, i) => `src-${i}`) };
        },
      },
      fetchSource: {
        description: "Fetch one source snapshot (~8KB rows).",
        execute: async ({ source }) => {
          await Bun.sleep(100);
          const seq = nextOrd();
          return {
            source,
            seq,
            rows: Array.from({ length: 64 }, (_, i) => ({
              i,
              ts: 1_700_000_000_000 + i * 997 + seq,
              v: Math.sin(i + source.length),
            })),
          };
        },
      },
      transformBatch: {
        description: "Normalize one batch of rows.",
        execute: async ({ batch }) => {
          await Bun.sleep(120);
          return { n: Array.isArray(batch) ? batch.length : 0, ok: true };
        },
      },
      aggregateRuns: {
        description: "Aggregate transformed batches.",
        execute: async ({ batches }) => {
          await Bun.sleep(90);
          return {
            total: Array.isArray(batches) ? batches.reduce((a: number, b: { n?: number }) => a + (b.n ?? 0), 0) : 0,
          };
        },
      },
      writeReport: {
        description: "Persist the report. Mutating.",
        execute: async ({ run }, ctx) => {
          await Bun.sleep(110);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          reports.set(String(run), (reports.get(String(run)) ?? 0) + 1);
          return { written: true, run };
        },
      },
      verifyReport: {
        description: "Verify the persisted report.",
        execute: async ({ run }) => {
          await Bun.sleep(30);
          return { verified: reports.has(String(run)), run };
        },
      },
    }),
    async *script(goal) {
      const run = String(goal.run);
      // `run` rides along on the first call for steering input recovery.
      const listed = yield { tool: "listSources", args: { run } };
      const sources = (listed.value as { sources?: string[] }).sources ?? [];
      const batches: unknown[] = [];
      for (const s of sources) {
        const snap = yield { tool: "fetchSource", args: { source: s, run } };
        batches.push(
          yield { tool: "transformBatch", args: { batch: (snap.value as { rows?: unknown[] }).rows ?? [] } },
        );
      }
      const agg = yield { tool: "aggregateRuns", args: { batches } };
      yield { tool: "writeReport", args: { run, total: (agg.value as { total?: number })?.total } };
      const v = yield { tool: "verifyReport", args: { run } };
      void v;
    },
    done: (v) => Boolean((v as { verified?: boolean })?.verified),
    terminal: "verifyReport",
    check(doneGoals) {
      return dupCheck("etl", doneGoals, "run", [{ name: "writeReport", get: (id) => reports.get(id) ?? 0 }]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* World 4 — incident triage: flaky search (12% transient failures),  */
/* retries cost a turn, mutating tail.                                */
/* ------------------------------------------------------------------ */

export const INCIDENT_KEYS = ["checkout-5xx", "login-latency", "worker-backlog", "webhook-timeouts"] as const;

export function createIncident(flakeP = 0.12): World {
  const filed = new Map<string, number>();
  const paged = new Map<string, number>();
  const attempts = new Map<string, number>();
  return {
    name: "incident",
    island:
      () =>
      async ({ input }) => {
        await Bun.sleep(200);
        const f = (input ?? {}) as Record<string, unknown>;
        return { rootCause: `spike in ${f.signature ?? "errors"}`, confidence: 0.82 };
      },
    tools: () => ({
      searchLogs: {
        description: "Search the log index. Transiently flaky.",
        execute: async ({ q }) => {
          const key = String(q);
          attempts.set(key, (attempts.get(key) ?? 0) + 1);
          await Bun.sleep(75);
          const n = attempts.get(key)!;
          // Deterministic flake: fails on the first attempt *of this stretch*
          // for keys whose hash lands in the flake band, succeeds on retry.
          // Attempts reset via beginStretch so a later stretch of the same key
          // cannot look clean after a prior retry warmed the counter — a fresh
          // shadow sandbox would then timeout on first call.
          if (n === 1 && hashStr(key) % 100 < flakeP * 100) throw new Error("upstream timeout");
          const seq = nextOrd();
          return {
            events: Array.from({ length: 24 }, (_, i) => ({
              lvl: i % 5 ? "info" : "error",
              msg: `${key} event ${i}`,
              ts: seq * 7 + i,
            })),
          };
        },
      },
      groupErrors: {
        description: "Group error events into signatures.",
        execute: async ({ events }) => {
          await Bun.sleep(35);
          const errs = Array.isArray(events) ? events.filter((e) => (e as { lvl?: string }).lvl === "error") : [];
          return { signature: `sig-${errs.length}`, groups: errs.length };
        },
      },
      fetchTrace: {
        description: "Fetch a representative trace.",
        execute: async ({ signature }) => {
          await Bun.sleep(90);
          return { traceId: `tr-${String(signature).slice(4)}`, spans: 42, slowest: "db.query" };
        },
      },
      diagnose: {
        description: "Judge the root cause. Model judgment.",
        execute: async () => {
          await Bun.sleep(225);
          return { rootCause: "connection pool exhaustion", confidence: 0.8 };
        },
      },
      fileIncident: {
        description: "Open an incident. Mutating.",
        execute: async ({ key }, ctx) => {
          await Bun.sleep(55);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          filed.set(String(key), (filed.get(String(key)) ?? 0) + 1);
          return { filed: true, key };
        },
      },
      pageOnCall: {
        description: "Page the on-call engineer. Mutating.",
        execute: async ({ key }, ctx) => {
          await Bun.sleep(40);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          paged.set(String(key), (paged.get(String(key)) ?? 0) + 1);
          return { paged: true, key };
        },
      },
    }),
    async *script(goal) {
      const key = String(goal.key);
      // Retry once on transient failure — each retry costs the driver a turn.
      // `key` rides along in the first call's args: steering recovers a
      // program's input from sequence[0] args, and the program's input is
      // {key} even though searchLogs itself queries by q.
      let logs: CallResult = yield { tool: "searchLogs", args: { q: key, key } };
      if (!logs.ok) logs = yield { tool: "searchLogs", args: { q: key, key } };
      if (!logs.ok) return;
      const grouped = yield {
        tool: "groupErrors",
        args: { events: (logs.value as { events?: unknown[] }).events ?? [] },
      };
      const sig = (grouped.value as { signature?: string }).signature ?? "sig-0";
      yield { tool: "fetchTrace", args: { signature: sig } };
      yield { tool: "diagnose", args: { signature: sig } };
      yield { tool: "fileIncident", args: { key, signature: sig } };
      const p = yield { tool: "pageOnCall", args: { key } };
      void p;
    },
    done: (v) => Boolean((v as { paged?: boolean })?.paged),
    terminal: "pageOnCall",
    fidelity: (events) => events.every((e) => e.ok),
    beginStretch() {
      attempts.clear();
    },
    check(doneGoals) {
      return dupCheck("incident", doneGoals, "key", [
        { name: "fileIncident", get: (id) => filed.get(id) ?? 0 },
        { name: "pageOnCall", get: (id) => paged.get(id) ?? 0 },
      ]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* World 5 — research: many reads, an island summary, one write.      */
/* Longest read tail; exercises KV of arming slack on oblivious runs. */
/* ------------------------------------------------------------------ */

export const RESEARCH_TOPICS = ["auth-flow", "queue-retry", "cache-stampede"] as const;

export function createResearch(): World {
  const notes = new Map<string, number>();
  return {
    name: "research",
    island:
      () =>
      async ({ input }) => {
        await Bun.sleep(200);
        return { summary: `summary of ${JSON.stringify(input).slice(0, 40)}` };
      },
    tools: () => ({
      grepCode: {
        description: "Grep the repo for a pattern.",
        execute: async ({ pattern }) => {
          await Bun.sleep(70);
          return {
            // `hits` is exactly the set the agent will read; `more` is the
            // long tail it skips. A loop over reads binds against an array
            // whose length equals how many times the call actually repeats.
            hits: Array.from({ length: 6 }, (_, i) => `src/m${i}/impl.ts:${40 + i}`),
            more: Array.from({ length: 6 }, (_, i) => `src/m${i + 6}/impl.ts:${40 + i}`),
            seq: nextOrd(),
          };
        },
      },
      readFile: {
        description: "Read one file.",
        execute: async ({ path }) => {
          await Bun.sleep(45);
          return { path, lines: Array.from({ length: 48 }, (_, i) => `line ${i} of ${path}`) };
        },
      },
      listDeps: {
        description: "List package dependencies.",
        execute: async () => {
          await Bun.sleep(35);
          return { deps: ["bus", "store", "queue", "http"] };
        },
      },
      summarizeModule: {
        description: "Summarize findings. Model judgment.",
        execute: async () => {
          await Bun.sleep(225);
          return { summary: "module handles X via Y" };
        },
      },
      writeNotes: {
        description: "Append research notes. Mutating.",
        execute: async ({ topic }, ctx) => {
          await Bun.sleep(50);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          notes.set(String(topic), (notes.get(String(topic)) ?? 0) + 1);
          return { notesWritten: true, topic };
        },
      },
    }),
    async *script(goal) {
      const topic = String(goal.topic);
      // `topic` rides along for steering input recovery (see incident world).
      const hits = yield { tool: "grepCode", args: { pattern: topic, topic } };
      const paths = (hits.value as { hits?: string[] }).hits ?? [];
      for (const p of paths.slice(0, 6)) {
        yield { tool: "readFile", args: { path: p } };
      }
      yield { tool: "listDeps", args: { topic } };
      yield { tool: "summarizeModule", args: { topic } };
      const w = yield { tool: "writeNotes", args: { topic } };
      void w;
    },
    done: (v) => Boolean((v as { notesWritten?: boolean })?.notesWritten),
    terminal: "writeNotes",
    check(doneGoals) {
      return dupCheck("research", doneGoals, "topic", [{ name: "writeNotes", get: (id) => notes.get(id) ?? 0 }]);
    },
  };
}

export function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/* ------------------------------------------------------------------ */
/* World 6 — thrash: an agent stuck in a failing probe→restart→verify */
/* cycle. The raw arm burns a dozen real restarts; enforcement mode is */
/* the only arm that can stop it. Correctness here is "fewer wasted    */
/* mutations", asserted by the scenario on `thrashRestartsFor`.        */
/* ------------------------------------------------------------------ */

/** Restart counts per service name, for scenario-level assertions. */
export const THRASH_RESTARTS = new Map<string, number>();

export function createThrash(cycles = 12): World {
  let verifyAttempts = 0;
  return {
    name: "thrash",
    island: () => async () => ({ ok: false }),
    tools: () => ({
      probeService: {
        description: "Health-probe the service.",
        execute: async ({ svc }) => {
          await Bun.sleep(25);
          return { svc, healthy: false, code: "E_DEGRADED" };
        },
      },
      restartService: {
        description: "Restart the service. Mutating and disruptive.",
        execute: async ({ svc }, ctx) => {
          await Bun.sleep(40);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(svc);
          THRASH_RESTARTS.set(k, (THRASH_RESTARTS.get(k) ?? 0) + 1);
          return { restarted: true, svc, nth: THRASH_RESTARTS.get(k) };
        },
      },
      verifyFix: {
        description: "Verify the service recovered.",
        execute: async ({ svc }) => {
          await Bun.sleep(30);
          verifyAttempts++;
          // Recovery only lands near the end — that is what makes it thrash.
          return { svc, verified: verifyAttempts >= cycles };
        },
      },
    }),
    async *script(goal) {
      const svc = String(goal.svc);
      for (let i = 0; i < cycles; i++) {
        yield { tool: "probeService", args: { svc } };
        yield { tool: "restartService", args: { svc } };
        const v = yield { tool: "verifyFix", args: { svc } };
        if ((v.value as { verified?: boolean })?.verified) return;
      }
    },
    done: (v) => Boolean((v as { verified?: boolean })?.verified),
    terminal: "verifyFix",
    check() {
      // Thrash is measured in spend, not invariants; the scenario asserts on
      // restart counts directly via THRASH_RESTARTS.
      return [];
    },
  };
}

export const ALL_WORLD_FACTORIES = [createDesk, createOrders, createEtl, createIncident, createResearch] as const;

export { THINK_NOTE, ok };
