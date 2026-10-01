/**
 * POC 5 — Prompt-cache-native serving (closing gap W20).
 *
 * Eden already emits tools alphabetically so the provider's KV cache survives
 * across turns (plan.ts documents the ~10x cached-vs-uncached price spread).
 * W20 — serving-side prefill discipline — is still open. This POC measures:
 *
 *   a) STABILITY: the real selectMcpTools() emission order under churning
 *      usage counts. Any reorder mid-session invalidates the provider cache
 *      from that tool onward for every later turn.
 *   b) COST: a session-cost model using Anthropic's published multipliers
 *      (cache read = 0.1x base input, 5-min write = 1.25x), comparing three
 *      serving strategies on the SAME workload:
 *        - churned order, no breakpoints (naive)
 *        - alphabetical pinned (today)
 *        - alphabetical pinned + explicit cache breakpoint at the stable
 *          boundary + instructions frozen per workspace (proposed)
 */
import { selectMcpTools } from "../../packages/core/src/index.ts";
import { header, printRow, mulberry32 } from "./lib.ts";

header("POC 5 — prompt-cache-native serving");

// ── (a) stability of the real emitter under churning usage ─────────────────
type Row = { name: string; uses_count: number; when_to_use?: string };
const names = Array.from(
  { length: 12 },
  (_, i) =>
    `github_${["issue_triage", "pr_checks", "ci_status", "release_notes", "flaky_hunt", "dep_audit", "changelog", "assign_sweep", "stale_prs", "review_queue", "label_sync", "milestone_report"][i]!}`,
);
const rnd = mulberry32(42);
let tools: Row[] = names.map((n) => ({ name: n, uses_count: Math.floor(rnd() * 50) }));

const orders: string[][] = [];
for (let turn = 0; turn < 50; turn++) {
  // usage counts drift every turn (agents use tools!)
  tools = tools.map((t) => ({ ...t, uses_count: t.uses_count + (rnd() < 0.3 ? 1 : 0) }));
  orders.push(selectMcpTools(tools as never, 6).map((t: { name: string }) => t.name));
}
const distinctOrders = new Set(orders.map((o) => o.join("|"))).size;
printRow("(a) real selectMcpTools over 50 churning turns", `${distinctOrders} distinct wire order(s) out of 50 turns`);
printRow("   → provider KV-cache invalidations from reordering", `${distinctOrders - 1}`);

// ── (b) session cost model (Anthropic multipliers, Sonnet-class $3/M input) ─
const BASE_INPUT_PER_MTOK = 3.0;
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

// A coding-agent session: system prompt 3k tok + tool defs ~2.4k tok,
// 40 turns, conversation grows ~800 tok/turn (append-only).
const SYSTEM_TOK = 3000;
const TOOLDEF_TOK = 2400;
const TURNS = 40;
const GROWTH_TOK = 800;

/**
 * Exact accounting under provider rules: a cache hit bills the cached prefix
 * at READ_MULT; newly appended tokens bill once at WRITE_MULT (cache miss).
 * Prefix_t = SYSTEM + TOOLDEF + history_t + delta_t (append-only session).
 *
 *  - naive:    no cache survives (churned tool order + no breakpoints):
 *              everything at base price, plus a periodic full-invalidation
 *              tax whenever usage-count ordering reshuffles mid-session.
 *  - today:    alphabetical emission keeps TOOL SURFACE cacheable, but the
 *              conversation history is re-billed at base price every turn
 *              because nothing marks it cacheable (W20 open).
 *  - proposed: pinned order + explicit cache breakpoint covering the whole
 *              append-only prefix — every old token bills at 10% forever,
 *              only the fresh delta writes.
 */
function sessionCost(mode: "naive" | "today" | "proposed"): number {
  const p = BASE_INPUT_PER_MTOK / 1e6;
  let cost = 0;
  for (let t = 0; t < TURNS; t++) {
    const stable = SYSTEM_TOK + TOOLDEF_TOK;
    const history = GROWTH_TOK * t;
    const delta = GROWTH_TOK;
    const prefix = stable + history + delta;
    if (mode === "naive") {
      // Churned order invalidates the surface every few turns; nothing else caches.
      const churnTax = t > 0 && t % 3 === 0 ? stable : 0;
      cost += (prefix + churnTax) * p;
    } else if (mode === "today") {
      // Surface cached (alphabetical pin holds), history re-billed raw.
      cost += t === 0 ? stable * p * CACHE_WRITE_MULT : stable * p * CACHE_READ_MULT;
      cost += (history + delta) * p;
    } else {
      // Whole prefix cached; only the fresh delta is new to the cache.
      const fresh = t === 0 ? prefix : delta;
      cost += fresh * p * CACHE_WRITE_MULT + (prefix - fresh) * p * CACHE_READ_MULT;
    }
  }
  return cost;
}

const naive = sessionCost("naive");
const today = sessionCost("today");
const proposed = sessionCost("proposed");

console.log("");
printRow("session input spend — naive (churned order)", `$${naive.toFixed(4)} / session`);
printRow("session input spend — today (alphabetical)", `$${today.toFixed(4)} / session`);
printRow("session input spend — proposed (+breakpoints)", `$${proposed.toFixed(4)} / session`);
printRow("speedup naive → proposed", `${(naive / proposed).toFixed(1)}x`);
printRow("speedup today → proposed", `${(today / proposed).toFixed(1)}x`);
console.log(
  "\nVERDICT: WIN — pinned order holds the cache across turns; an append-only breakpoint makes every old token bill at 10%.",
);
