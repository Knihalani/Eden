import type { StretchProgram } from "@eden/ir";
import { argShapes, firstCommandTemplate, programFirstStepShapes, templateFits } from "./steer";

/**
 * Dispatch surface policy (docs/dispatch.md).
 *
 * The catalog lives in the runtime, not in the model's context. EDEN_SURFACE
 * picks how much of it a request may see:
 *
 *   all        every live program's schema is appended to the client's tools
 *              (the pre-Dispatch behavior, and still the default).
 *   none       nothing is injected. Routing is purely reactive steering: the
 *              model writes its natural raw call and the proxy rewrites it.
 *              Zero Eden tokens in context, zero catalog churn.
 *   jit        at most ONE program's schema is injected, chosen per-request
 *              by the deterministic intent scorer below, only when concrete
 *              structural evidence (a URL shape, a CLI shape, a command
 *              template fit) appears in the conversation. Silence otherwise.
 *   jit-shadow behaves exactly like `none` but logs which single program the
 *              scorer WOULD have surfaced. This is how precision is measured
 *              on real traffic before jit is allowed anywhere near it.
 *
 * The default is "all" so an upgrade changes nothing until an operator opts
 * in — the same observe-mode doctrine as steering itself.
 */
export type SurfaceMode = "all" | "none" | "jit" | "jit-shadow";

export function surfaceMode(): SurfaceMode {
  const v = String(process.env.EDEN_SURFACE || "")
    .trim()
    .toLowerCase();
  if (v === "none") return "none";
  if (v === "jit") return "jit";
  if (v === "jit-shadow" || v === "shadow") return "jit-shadow";
  return "all";
}

/**
 * Deterministic intent scoring. No embeddings, no model call: the same
 * structural vocabulary reactive steering matches on is what a conversation
 * exhibits before the agent writes its loop.
 *
 * Evidence tiers (a program's score is its best evidence plus capped token
 * overlap):
 *   +4  shape hit      a URL or CLI shape extracted from recent messages equals
 *                      one of the program's first-step witness shapes.
 *   +3  template fit   the program's shell command template structurally fits
 *                      a command-looking string in the messages (same binary,
 *                      same arity, same flags — slot positions may differ).
 *   +1  token overlap  distinct informative words shared between the program's
 *                      name/sequence and the message text, capped at +2 total.
 *
 * MIN_SCORE = 3 means token overlap alone can NEVER surface anything: a
 * mention of the word "ticket" is not evidence. This gate is what keeps
 * routing precision measurable and the fail-closed story intact — a wrong
 * route must be refused by the envelope, and the cheapest way to be right is
 * to only speak when there is structure to match.
 */
const SCORE_SHAPE = 4;
const SCORE_TEMPLATE = 3;
export const INTENT_MIN_SCORE = 3;

export type RankedMatch = {
  program: StretchProgram;
  score: number;
  /** Which evidence fired: "shape" | "template" | "tokens". Best first. */
  via: "shape" | "template" | "tokens";
};

/** Words too generic to count as evidence on their own. */
const STOP_TOKENS = new Set([
  "tool",
  "tools",
  "fetch",
  "fetches",
  "get",
  "gets",
  "check",
  "checks",
  "view",
  "list",
  "run",
  "runs",
  "call",
  "calls",
  "step",
  "steps",
  "bundle",
  "status",
]);

function informativeTokens(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOP_TOKENS.has(t));
}

/**
 * Pull candidate text out of a request's messages — OpenAI and Anthropic
 * dialects both, since the scorer runs before either handler branches. Only
 * string content is read; depth and volume are bounded so a pathological
 * payload costs bounded work.
 */
export function messageText(messages: readonly unknown[], maxMessages = 8): string {
  const parts: string[] = [];
  const msgs = messages.slice(-maxMessages);
  const walk = (v: unknown, depth: number): void => {
    if (parts.length > 64 || depth > 4) return;
    if (typeof v === "string") {
      if (v.length) parts.push(v.slice(0, 2000));
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      // Content blocks: {type:"text", text}, tool results, etc. Read the
      // usual text-bearing fields; ignore ids, roles, schemas.
      for (const key of ["content", "text", "command", "url"]) {
        if (key in o) walk(o[key], depth + 1);
      }
    }
  };
  for (const m of msgs) walk(m, 0);
  return parts.join("\n").slice(0, 16_000);
}

function programTokens(p: StretchProgram): Set<string> {
  const out = new Set<string>();
  for (const t of informativeTokens(p.name || "")) out.add(t);
  for (const n of p.sequence ?? []) for (const t of informativeTokens(n)) out.add(t);
  return out;
}

/**
 * Rank programs against a conversation. Returns ALL candidates that clear the
 * evidence bar, best first; callers decide how many may be surfaced (Dispatch
 * caps it at one). Never throws on program weirdness — a corrupt program
 * scores zero instead of poisoning the pass.
 */
export function rankPrograms(messages: readonly unknown[], programs: StretchProgram[]): RankedMatch[] {
  const text = messageText(messages);
  if (!text) return [];
  const msgShapes = new Set<string>();
  try {
    // Reuse steer's extractor: each message string goes through the same
    // argShapes pipeline a raw call's arguments go through, so both sides of
    // the comparison land on one spelling.
    for (const s of text.split("\n")) {
      for (const sh of argShapes({ v: s })) msgShapes.add(sh);
    }
  } catch {
    /* no shapes is fine; scoring continues on text alone */
  }
  const ranked: RankedMatch[] = [];
  for (const p of programs) {
    if (!p.manifest) continue;
    let score = 0;
    let via: RankedMatch["via"] = "tokens";
    try {
      const progShapes = programFirstStepShapes(p);
      if (msgShapes.size && progShapes.some((s) => msgShapes.has(s))) {
        score += SCORE_SHAPE;
        via = "shape";
      }
      const tmpl = firstCommandTemplate(p);
      if (!score && tmpl) {
        for (const line of text.split("\n")) {
          if (templateFits(tmpl, line.trim())) {
            score += SCORE_TEMPLATE;
            via = "template";
            break;
          }
        }
      }
    } catch {
      continue; // corrupt program: no opinion, never a crash
    }
    let hits = 0;
    const lower = text.toLowerCase();
    for (const t of programTokens(p)) {
      if (lower.includes(t)) {
        hits++;
        if (hits >= 2) break;
      }
    }
    score += Math.min(hits, 2);
    if (score >= INTENT_MIN_SCORE) ranked.push({ program: p, score, via });
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (b.program.sequence?.length ?? 0) - (a.program.sequence?.length ?? 0) ||
      a.program.name.localeCompare(b.program.name),
  );
  return ranked;
}

export type SurfaceSelection = {
  /** Programs whose schemas may be injected this request. */
  surface: StretchProgram[];
};

/**
 * Apply the surface policy. `onShadow` fires at most once per request under
 * jit-shadow, naming what would have been surfaced — the telemetry that lets
 * jit earn its rollout (precision target ≥ 95% on shadow traffic first).
 */
export function selectSurfacePrograms(opts: {
  mode: SurfaceMode;
  live: StretchProgram[];
  messages?: unknown[];
  onShadow?: (names: string[]) => void;
}): SurfaceSelection {
  const { mode, live, onShadow } = opts;
  const msgs = opts.messages;
  if (mode === "none") return { surface: [] };
  if (mode !== "all" && !msgs?.length) {
    // jit / jit-shadow without a conversation to read have no evidence and no
    // business surfacing anything: degrade to silence, never to the catalog.
    return { surface: [] };
  }
  if (mode === "all") return { surface: live };
  let ranked: RankedMatch[] = [];
  try {
    ranked = msgs ? rankPrograms(msgs, live) : [];
  } catch {
    ranked = []; // scorer fault degrades to silence, never to a fat catalog
  }
  const names = ranked.slice(0, 1).map((m) => m.program.name);
  if (mode === "jit-shadow") {
    if (names.length) onShadow?.(names);
    return { surface: [] };
  }
  return { surface: ranked.length ? [ranked[0]!.program] : [] };
}

/**
 * The one entry point request handlers call: reads EDEN_SURFACE, applies the
 * policy, logs shadow candidates. On any internal fault it degrades to the
 * historic full catalog — steering is unaffected either way, and a fat catalog
 * costs tokens while silence-by-crash starves the library silently.
 */
export function selectForRequest(live: StretchProgram[], messages?: unknown[]): StretchProgram[] {
  let selected = live;
  try {
    selected = selectSurfacePrograms({
      mode: surfaceMode(),
      live,
      messages,
      onShadow: (names) => console.error(`[eden] intent-shadow: would surface ${names.join(", ")}`),
    }).surface;
  } catch {
    selected = live;
  }
  return selected;
}
