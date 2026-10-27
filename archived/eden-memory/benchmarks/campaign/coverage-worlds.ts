/**
 * Coverage-expansion worlds (Wave 1.3): regimes with no prior campaign fixture.
 *
 *   slow-tool      — wrap timeout << tool sleep; deopt-claim / exactly-once
 *   long-session   — small entity pool for 100+ stretch scenarios (count is a
 *                    scenario option; the world is the fixture)
 *   high-card      — unique goal ids, identical tool sequence/shape (envelope
 *                    / OOD lesson; distinct from createNoise which changes seqs)
 *   pagination     — list page1→page2→page3 then per-item mutate (read-set /
 *                    bindable loop lesson: cursor walk refuses foreach)
 *   pagination-bindable — one listAll array then per-item mutate (foreach mines)
 *   partial-iteration — Wave 3 rotation: 12 hits returned, 6 read (named miss)
 *
 * Wave 1 does not change product behavior — benches and tests only.
 */
import { mulberry32 } from "@eden/measure";
import { hashStr, type CallResult, type World } from "./worlds";

function ok(v: unknown): CallResult {
  return { ok: true, value: v };
}

/** Per-process ordinal so identical entity stretches do not hash-collapse. */
let covOrd = 0;
function nextOrd(): number {
  return ++covOrd;
}

/** Wrap timeout the slow-tool world sleeps past. Bench sets EDEN_TIMEOUT_MS to match. */
export function campaignWrapTimeoutMs(): number {
  const n = Number(process.env.CAMPAIGN_WRAP_TIMEOUT_MS ?? 120);
  return Number.isFinite(n) && n > 0 ? n : 120;
}

/* ------------------------------------------------------------------ */
/* slow-tool — lookup → applyCredit → slowFetch (>timeout) → notify   */
/* ------------------------------------------------------------------ */

/** When false, slowFetch is fast so witness/shadow can compile; bench arms it for live. */
export let slowToolLiveArmed = false;
export function armSlowToolLive(armed: boolean): void {
  slowToolLiveArmed = armed;
}

type SlowState = {
  credits: Map<string, number>;
  notifies: Map<string, number>;
};

export function createSlowTool(): World {
  const st: SlowState = { credits: new Map(), notifies: new Map() };
  const timeoutMs = campaignWrapTimeoutMs();
  return {
    name: "slow-tool",
    island: () => async () => ({ ok: false }),
    tools: () => ({
      lookup: {
        description: "Fast entity lookup.",
        execute: async ({ id }) => {
          await Bun.sleep(8);
          return { id, found: true, seq: nextOrd() };
        },
      },
      applyCredit: {
        description: "Apply a credit. Mutating.",
        execute: async ({ id }, ctx) => {
          await Bun.sleep(10);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          st.credits.set(String(id), (st.credits.get(String(id)) ?? 0) + 1);
          return { applied: true, id };
        },
      },
      slowFetch: {
        description: "Provider call slower than wrap timeout when live-armed (timeout*4).",
        execute: async ({ id }, ctx) => {
          await Bun.sleep(slowToolLiveArmed ? timeoutMs * 4 : 8);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          return { id, payload: "late", seq: nextOrd() };
        },
      },
      notify: {
        description: "Notify customer. Mutating.",
        execute: async ({ id }, ctx) => {
          await Bun.sleep(8);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          st.notifies.set(String(id), (st.notifies.get(String(id)) ?? 0) + 1);
          return { notified: true, id };
        },
      },
    }),
    async *script(goal) {
      const id = String(goal.id);
      yield { tool: "lookup", args: { id } };
      yield { tool: "applyCredit", args: { id } };
      yield { tool: "slowFetch", args: { id } };
      const n = yield { tool: "notify", args: { id } };
      void n;
    },
    done: (v) => Boolean((v as { notified?: boolean })?.notified),
    terminal: "notify",
    check(doneGoals) {
      // applyCredit exactly-once per stretch; notify 0 or 1 never 2 (deopt may
      // leave notify unreached — that is honest, not a violation).
      const occ = new Map<string, number>();
      for (const g of doneGoals) occ.set(String(g.id), (occ.get(String(g.id)) ?? 0) + 1);
      const bad: string[] = [];
      for (const [id, n] of occ) {
        const c = st.credits.get(id) ?? 0;
        const note = st.notifies.get(id) ?? 0;
        if (c > n) bad.push(`slow-tool:${id}: applyCredit ran ${c}x across ${n} stretch(es) — duplicated`);
        if (note > n) bad.push(`slow-tool:${id}: notify ran ${note}x across ${n} stretch(es) — duplicated`);
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* long-session — compact linear stretch over a small cycling pool    */
/* ------------------------------------------------------------------ */

export const LONG_SESSION_IDS = ["LS-1", "LS-2", "LS-3", "LS-4"] as const;

type LongState = {
  applies: Map<string, number>;
  finals: Map<string, number>;
};

/** Fixture for very-long sessions. Stretch count is a scenario option. */
export function createLongSession(): World {
  const st: LongState = { applies: new Map(), finals: new Map() };
  const accounts: Record<string, { plan: string }> = {};
  for (const id of LONG_SESSION_IDS) accounts[id] = { plan: "pro" };
  return {
    name: "long-session",
    island: () => async () => ({ ok: false }),
    tools: () => ({
      fetchAcct: {
        description: "Fetch account.",
        execute: async ({ id }) => {
          await Bun.sleep(8);
          return { ...(accounts[String(id)] ?? { missing: true, id }), seq: nextOrd() };
        },
      },
      classify: {
        description: "Classify request.",
        execute: async ({ id }) => {
          await Bun.sleep(6);
          return { category: "billing", id, seq: nextOrd() };
        },
      },
      applyFix: {
        description: "Apply fix. Mutating.",
        execute: async ({ id }, ctx) => {
          await Bun.sleep(10);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          st.applies.set(String(id), (st.applies.get(String(id)) ?? 0) + 1);
          return { applied: true, id };
        },
      },
      auditLine: {
        description: "Write audit line.",
        execute: async ({ id }) => {
          await Bun.sleep(6);
          return { audited: true, id, seq: nextOrd() };
        },
      },
      finalize: {
        description: "Finalize stretch. Mutating.",
        execute: async ({ id }, ctx) => {
          await Bun.sleep(8);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          st.finals.set(String(id), (st.finals.get(String(id)) ?? 0) + 1);
          return { done: true, id };
        },
      },
    }),
    async *script(goal) {
      const id = String(goal.id);
      yield { tool: "fetchAcct", args: { id } };
      yield { tool: "classify", args: { id } };
      yield { tool: "applyFix", args: { id } };
      yield { tool: "auditLine", args: { id } };
      const f = yield { tool: "finalize", args: { id } };
      void f;
    },
    done: (v) => Boolean((v as { done?: boolean })?.done),
    terminal: "finalize",
    check(doneGoals) {
      const occ = new Map<string, number>();
      for (const g of doneGoals) occ.set(String(g.id), (occ.get(String(g.id)) ?? 0) + 1);
      const bad: string[] = [];
      for (const [id, n] of occ) {
        const a = st.applies.get(id) ?? 0;
        const f = st.finals.get(id) ?? 0;
        if (a > n) bad.push(`long-session:${id}: applyFix ran ${a}x across ${n} stretch(es) — duplicated`);
        if (f > n) bad.push(`long-session:${id}: finalize ran ${f}x across ${n} stretch(es) — duplicated`);
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* high-card — unique ids, identical 5-step mutating shape             */
/* ------------------------------------------------------------------ */

type HighCardState = {
  writes: Map<string, number>;
};

/**
 * Envelope/OOD lesson: every goal has a novel id but the same tool sequence.
 * Distinct from createNoise, which shuffles sequences per id.
 */
export function createHighCard(): World {
  const st: HighCardState = { writes: new Map() };
  return {
    name: "high-card",
    island: () => async () => ({ ok: false }),
    tools: () => ({
      getEntity: {
        description: "Fetch entity by id.",
        execute: async ({ id }) => {
          await Bun.sleep(8);
          return { id, kind: "ticket", hash: hashStr(String(id)), seq: nextOrd() };
        },
      },
      classifyEnt: {
        description: "Classify entity.",
        execute: async ({ id }) => {
          await Bun.sleep(6);
          return { id, tag: "standard", seq: nextOrd() };
        },
      },
      prepWrite: {
        description: "Prepare write payload.",
        execute: async ({ id }) => {
          await Bun.sleep(6);
          return { id, draft: true, seq: nextOrd() };
        },
      },
      commitWrite: {
        description: "Commit write. Mutating.",
        execute: async ({ id }, ctx) => {
          await Bun.sleep(10);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          st.writes.set(String(id), (st.writes.get(String(id)) ?? 0) + 1);
          return { written: true, id };
        },
      },
      ackWrite: {
        description: "Acknowledge write.",
        execute: async ({ id }) => {
          await Bun.sleep(5);
          return { acked: true, id };
        },
      },
    }),
    async *script(goal) {
      const id = String(goal.id);
      yield { tool: "getEntity", args: { id } };
      yield { tool: "classifyEnt", args: { id } };
      yield { tool: "prepWrite", args: { id } };
      yield { tool: "commitWrite", args: { id } };
      const a = yield { tool: "ackWrite", args: { id } };
      void a;
    },
    done: (v) => Boolean((v as { acked?: boolean })?.acked),
    terminal: "ackWrite",
    check(doneGoals) {
      const occ = new Map<string, number>();
      for (const g of doneGoals) occ.set(String(g.id), (occ.get(String(g.id)) ?? 0) + 1);
      const bad: string[] = [];
      for (const [id, n] of occ) {
        const w = st.writes.get(id) ?? 0;
        if (w > n) bad.push(`high-card:${id}: commitWrite ran ${w}x across ${n} stretch(es) — duplicated`);
        if (w < n) bad.push(`high-card:${id}: commitWrite ran ${w}x across ${n} stretch(es) — missing`);
      }
      return bad;
    },
  };
}

/** Canonical high-card tool order (shared by every unique id). */
export const HIGH_CARD_SEQUENCE = ["getEntity", "classifyEnt", "prepWrite", "commitWrite", "ackWrite"] as const;

/* ------------------------------------------------------------------ */
/* pagination — list pages (cursor) then write each item               */
/* ------------------------------------------------------------------ */

export const PAGE_ITEMS = ["P-a", "P-b", "P-c", "P-d", "P-e", "P-f"] as const;
const PAGE_SIZE = 2;

type PageState = {
  writes: Map<string, number>;
};

/**
 * Arc 4 read-set exposure / grepCode lesson: result array length must equal
 * later loop count. Walks page1→page2→page3 then mutates each collected id.
 */
export function createPagination(): World {
  const st: PageState = { writes: new Map() };
  const pages: string[][] = [];
  for (let i = 0; i < PAGE_ITEMS.length; i += PAGE_SIZE) {
    pages.push([...PAGE_ITEMS.slice(i, i + PAGE_SIZE)]);
  }
  return {
    name: "pagination",
    island: () => async () => ({ ok: false }),
    tools: () => ({
      listPage: {
        description: "List one page of items by cursor (null = first page).",
        execute: async ({ cursor }) => {
          await Bun.sleep(10);
          const idx = cursor == null || cursor === "" ? 0 : Number(cursor);
          const items = pages[idx] ?? [];
          const next = idx + 1 < pages.length ? String(idx + 1) : null;
          return { items, nextCursor: next, page: idx, seq: nextOrd() };
        },
      },
      getItem: {
        description: "Fetch one item by id.",
        execute: async ({ id }) => {
          await Bun.sleep(6);
          return { id, ok: PAGE_ITEMS.includes(String(id) as (typeof PAGE_ITEMS)[number]), seq: nextOrd() };
        },
      },
      writeItem: {
        description: "Persist one item. Mutating.",
        execute: async ({ id }, ctx) => {
          await Bun.sleep(8);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          st.writes.set(String(id), (st.writes.get(String(id)) ?? 0) + 1);
          return { written: true, id };
        },
      },
      sealBatch: {
        description: "Seal the batch after all items are written.",
        execute: async ({ batch }) => {
          await Bun.sleep(5);
          return { sealed: true, batch };
        },
      },
    }),
    async *script(goal) {
      const batch = String(goal.batch ?? "default");
      const collected: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = yield { tool: "listPage", args: { cursor, batch } };
        const body = (page.value ?? {}) as { items?: string[]; nextCursor?: string | null };
        for (const id of body.items ?? []) collected.push(id);
        if (body.nextCursor == null) break;
        cursor = body.nextCursor;
      }
      for (const id of collected) {
        yield { tool: "getItem", args: { id, batch } };
        yield { tool: "writeItem", args: { id, batch } };
      }
      const seal = yield { tool: "sealBatch", args: { batch } };
      void seal;
    },
    done: (v) => Boolean((v as { sealed?: boolean })?.sealed),
    terminal: "sealBatch",
    check(doneGoals) {
      // Each completed stretch walks the full catalog; writes per item must
      // equal stretch count. Missing writes (got < n) are the read-set /
      // bindable-loop failure mode — a compiled program that seals without
      // mutating every listed id. Duplicates (got > n) are the other.
      const n = doneGoals.length;
      const bad: string[] = [];
      for (const id of PAGE_ITEMS) {
        const got = st.writes.get(id) ?? 0;
        if (got > n) bad.push(`pagination:${id}: writeItem ran ${got}x across ${n} stretch(es) — duplicated`);
        if (got < n) bad.push(`pagination:${id}: writeItem ran ${got}x across ${n} stretch(es) — missing`);
      }
      return bad;
    },
  };
}

/**
 * Bindable pagination: one `listAll` returns the full catalog as an array,
 * then getItem+writeItem per id. Inverse of `createPagination` (cursor walk
 * that compiles to until+flatten).
 * compile.test.ts "mines a foreach loop over a prior array" is the unit pin;
 * this world is the campaign-shaped version of that lesson.
 */
export function createPaginationBindable(): World {
  const st: PageState = { writes: new Map() };
  return {
    name: "pagination-bindable",
    island: () => async () => ({ ok: false }),
    tools: () => ({
      listAll: {
        description: "Return the full item catalog as one array (bindable loop source).",
        execute: async ({ batch }) => {
          await Bun.sleep(10);
          return { items: [...PAGE_ITEMS], batch, seq: nextOrd() };
        },
      },
      getItem: {
        description: "Fetch one item by id.",
        execute: async ({ id }) => {
          await Bun.sleep(6);
          return { id, ok: PAGE_ITEMS.includes(String(id) as (typeof PAGE_ITEMS)[number]), seq: nextOrd() };
        },
      },
      writeItem: {
        description: "Persist one item. Mutating.",
        execute: async ({ id }, ctx) => {
          await Bun.sleep(8);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          st.writes.set(String(id), (st.writes.get(String(id)) ?? 0) + 1);
          return { written: true, id };
        },
      },
      sealBatch: {
        description: "Seal the batch after all items are written.",
        execute: async ({ batch }) => {
          await Bun.sleep(5);
          return { sealed: true, batch };
        },
      },
    }),
    async *script(goal) {
      const batch = String(goal.batch ?? "default");
      const listed = yield { tool: "listAll", args: { batch } };
      const items = ((listed.value ?? {}) as { items?: string[] }).items ?? [];
      for (const id of items) {
        yield { tool: "getItem", args: { id, batch } };
        yield { tool: "writeItem", args: { id, batch } };
      }
      const seal = yield { tool: "sealBatch", args: { batch } };
      void seal;
    },
    done: (v) => Boolean((v as { sealed?: boolean })?.sealed),
    terminal: "sealBatch",
    check(doneGoals) {
      const n = doneGoals.length;
      const bad: string[] = [];
      for (const id of PAGE_ITEMS) {
        const got = st.writes.get(id) ?? 0;
        if (got > n) bad.push(`pagination-bindable:${id}: writeItem ran ${got}x across ${n} stretch(es) — duplicated`);
        if (got < n) bad.push(`pagination-bindable:${id}: writeItem ran ${got}x across ${n} stretch(es) — missing`);
      }
      return bad;
    },
  };
}

/**
 * Wave 3 rotation (not silent-host): a search returns 12 hits, the agent
 * reads 6, then writes. The loop is unbindable — named `read_set_mismatch`,
 * not a silent host or a guessed foreach over the unread tail.
 */
export const PARTIAL_HITS = 12;
export const PARTIAL_READS = 6;

export function createPartialIteration(): World {
  const notes = new Map<string, number>();
  return {
    name: "partial-iteration",
    island: () => async () => ({ ok: false }),
    tools: () => ({
      grepCode: {
        description: "Grep the repo. Returns more hits than the agent will read.",
        execute: async ({ pattern }) => {
          await Bun.sleep(8);
          const hits = Array.from({ length: PARTIAL_HITS }, (_, i) => `src/m${i}/${pattern}.ts:${40 + i}`);
          return { hits, seq: nextOrd() };
        },
      },
      readFile: {
        description: "Read one file.",
        execute: async ({ path }) => {
          await Bun.sleep(6);
          return { path, lines: [`line of ${path}`] };
        },
      },
      writeNotes: {
        description: "Append notes. Mutating.",
        execute: async ({ topic }, ctx) => {
          await Bun.sleep(8);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          notes.set(String(topic), (notes.get(String(topic)) ?? 0) + 1);
          return { notesWritten: true, topic };
        },
      },
    }),
    async *script(goal) {
      const topic = String(goal.topic ?? "auth");
      const hits = yield { tool: "grepCode", args: { pattern: topic, topic } };
      const paths = ((hits.value as { hits?: string[] }).hits ?? []).slice(0, PARTIAL_READS);
      for (const p of paths) {
        yield { tool: "readFile", args: { path: p } };
      }
      const w = yield { tool: "writeNotes", args: { topic } };
      void w;
    },
    done: (v) => Boolean((v as { notesWritten?: boolean })?.notesWritten),
    terminal: "writeNotes",
    check(doneGoals) {
      const n = doneGoals.length;
      const bad: string[] = [];
      for (const g of doneGoals) {
        const topic = String(g.topic);
        const got = notes.get(topic) ?? 0;
        if (got !== 1) bad.push(`partial-iteration:${topic}: writeNotes ran ${got}x (want 1)`);
      }
      if (doneGoals.length !== n) bad.push("partial-iteration: goal count drifted");
      return bad;
    },
  };
}

/** Drive one script against a world's tools; returns tool names in order. */
export async function collectSequence(world: World, goal: Record<string, unknown>, seed = 1): Promise<string[]> {
  const tools = world.tools();
  const rng = mulberry32(seed >>> 0);
  const gen = world.script(goal, rng);
  const seq: string[] = [];
  let sent: CallResult | undefined;
  for (;;) {
    const next = await gen.next(sent as never);
    if (next.done) break;
    const { tool, args } = next.value;
    seq.push(tool);
    try {
      const v = await tools[tool]!.execute(args);
      sent = ok(v);
    } catch (err) {
      sent = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return seq;
}
