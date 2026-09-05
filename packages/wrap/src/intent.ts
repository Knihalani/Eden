import type { StretchProgram } from "@eden/ir";
import { jitMax } from "@eden/ir";
import { argShapes, firstCommandTemplate, programFirstStepShapes, templateFits } from "./steer";
import { looksLikeDenseWitness } from "../../core/src/shapes";

/**
 * Dispatch surface policy (docs/dispatch.md).
 *
 * The catalog lives in the runtime, not in the model's context. EDEN_SURFACE
 * picks how much of it a request may see:
 *
 *   all        every live program's schema is appended to the client's tools
 *              (the pre-Dispatch behavior). Opt in with EDEN_SURFACE=all.
 *   none       nothing is injected. Routing is purely reactive steering: the
 *              model writes its natural raw call and the proxy rewrites it.
 *              Zero Eden tokens in context, zero catalog churn.
 *   jit        at most ONE program's schema is injected, chosen per-request
 *              by the deterministic intent scorer below, only when concrete
 *              structural evidence (a URL shape, a CLI shape, a command
 *              template fit, or an envelope witness id) appears in the
 *              conversation. Silence otherwise.
 *   jit-shadow behaves exactly like `none` but logs which single program the
 *              scorer WOULD have surfaced. This is how precision is measured
 *              on real traffic before jit is allowed anywhere near it.
 *
 * The default is "jit" after the Wave 22.2 soak printed PASS at the
 * registered bar (precision ≥ 0.95, unique-work empty catalog). Set
 * EDEN_SURFACE=all to restore the historic full catalog.
 */
export type SurfaceMode = "all" | "none" | "jit" | "jit-shadow";

export function surfaceMode(): SurfaceMode {
  const v = String(process.env.EDEN_SURFACE || "")
    .trim()
    .toLowerCase();
  if (v === "none") return "none";
  if (v === "all") return "all";
  if (v === "jit-shadow" || v === "shadow") return "jit-shadow";
  if (v === "jit") return "jit";
  if (!v) return "jit";
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
 *   +3  envelope hit   a dense token in the messages equals a dense string in
 *                      that program's envelope.inputs (account id, UUID, email,
 *                      ARN, Stripe id, S3 URI, GID). Exact membership only.
 *   +1  token overlap  distinct informative words shared between the program's
 *                      name/sequence and the message text, capped at +2 total.
 *
 * MIN_SCORE = 3 means token overlap alone can NEVER surface anything: a
 * mention of the word "ticket" is not evidence. Envelope hits require the
 * exact id to have been witnessed on that program — `N-0` and `ticket 123`
 * stay silent unless those values are in the envelope.
 */
const SCORE_SHAPE = 4;
const SCORE_TEMPLATE = 3;
const SCORE_WITNESS = 3;
export const INTENT_MIN_SCORE = 3;

export type RankedMatch = {
  program: StretchProgram;
  score: number;
  /** Which evidence fired: "shape" | "template" | "witness" | "tokens". Best first. */
  via: "shape" | "template" | "witness" | "tokens";
};

type RankedInternal = RankedMatch & { idx: number };

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
      for (const key of ["content", "text", "command", "url", "thinking"]) {
        if (key in o) walk(o[key], depth + 1);
      }
    }
  };
  for (const m of msgs) {
    walk(m, 0);
    if (m && typeof m === "object") {
      const o = m as Record<string, unknown>;
      const rc = o.reasoning_content;
      if (typeof rc === "string" && rc.length) parts.push(rc.slice(0, 2000));
      const rs = o.reasoning;
      if (typeof rs === "string" && rs.length) parts.push(rs.slice(0, 2000));
    }
  }
  return parts.join("\n").slice(0, 16_000);
}

function programTokens(p: StretchProgram): Set<string> {
  const out = new Set<string>();
  for (const t of informativeTokens(p.name || "")) out.add(t);
  for (const n of p.sequence ?? []) for (const t of informativeTokens(n)) out.add(t);
  return out;
}

const DENSE_EXTRACT =
  /[^\s]+@[^\s]+|s3:\/\/[^\s]+|arn:aws:[^\s]+|gid:\/\/[^\s]+|\+[1-9]\d{6,14}|[A-Za-z0-9_.:/-]{4,}/g;

/** Dense tokens in conversation text. One pass per rankPrograms call. */
export function denseTokensFromText(text: string): Set<string> {
  const out = new Set<string>();
  const matches = text.match(DENSE_EXTRACT) ?? [];
  for (const raw of matches) {
    const t = raw.replace(/[.,;:!?)]+$/g, "");
    if (looksLikeDenseWitness(t)) out.add(t);
  }
  return out;
}

/** Envelope values that are themselves dense witnesses. */
export function envelopeDenseWitnesses(p: StretchProgram): string[] {
  const out: string[] = [];
  for (const vals of Object.values(p.contract.envelope?.inputs ?? {})) {
    if (!Array.isArray(vals)) continue;
    for (const v of vals) {
      if (typeof v === "string" && looksLikeDenseWitness(v)) out.push(v);
    }
  }
  return out;
}

/**
 * Drop trailing English so `psql -c 'select 1' please` still has shape
 * `cli:psql` and still template-fits. The cut requires a space before the
 * conjunction, so `please handle ticket 123` is unchanged.
 */
function commandCandidateLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(trimmed);
    const cut = trimmed.search(/\s+(and|please|then|tell|for me)\b/i);
    if (cut > 0) out.push(trimmed.slice(0, cut).trim());
  }
  return out;
}

/**
 * `github.com/o/r/issues/1` without a scheme is still a GitHub URL.
 * `api.github.com/repos/o/r/issues/{id}` and `github.com/o/r/issues/{id}`
 * are the same resource kind so a forge seed compiled from acme/app still
 * JIT-matches a stranger's KaiavN/Eden link.
 */
export function githubBareUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:https?:\/\/)?(?:www\.)?(github\.com|api\.github\.com)\/[^\s"'<>]+/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0].replace(/[.,;:!?)]+$/g, "");
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Resource kind after owner/repo: issues/{id} vs pulls/{id}, host-agnostic. */
export function githubResourceKey(shape: string): string | null {
  const s = shape.replace(/^https?:\/\//i, "");
  const m = s.match(/^(?:api\.)?github\.com(?:\/repos)?\/[^/]+\/[^/]+\/(issues|pulls|pull)(\/\{id\}.*)$/i);
  if (!m) return null;
  const kind = m[1]!.toLowerCase() === "pull" ? "pulls" : m[1]!.toLowerCase();
  return `gh:${kind}${m[2]!.replaceAll("{issue}", "{id}")}`;
}

function githubShapeHit(msgShapes: Set<string>, progShapes: string[]): boolean {
  if (progShapes.some((s) => msgShapes.has(s))) return true;
  const msgGh = new Set<string>();
  for (const s of msgShapes) {
    const k = githubResourceKey(s);
    if (k) msgGh.add(k);
  }
  if (!msgGh.size) return false;
  return progShapes.some((s) => {
    const k = githubResourceKey(s);
    return Boolean(k && msgGh.has(k));
  });
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
    for (const s of commandCandidateLines(text)) {
      for (const sh of argShapes({ v: s })) msgShapes.add(sh);
    }
    for (const u of githubBareUrls(text)) {
      for (const sh of argShapes({ v: u })) msgShapes.add(sh);
    }
  } catch {
    /* no shapes is fine; scoring continues on text alone */
  }
  const msgWitnesses = denseTokensFromText(text);
  const ranked: RankedInternal[] = [];
  for (let i = 0; i < programs.length; i++) {
    const p = programs[i]!;
    if (!p.manifest) continue;
    let score = 0;
    let via: RankedMatch["via"] = "tokens";
    try {
      const progShapes = programFirstStepShapes(p);
      if (msgShapes.size && githubShapeHit(msgShapes, progShapes)) {
        score += SCORE_SHAPE;
        via = "shape";
      }
      const tmpl = firstCommandTemplate(p);
      if (!score && tmpl) {
        for (const line of commandCandidateLines(text)) {
          if (templateFits(tmpl, line)) {
            score += SCORE_TEMPLATE;
            via = "template";
            break;
          }
        }
      }
      if (!score) {
        const env = envelopeDenseWitnesses(p);
        if (env.some((w) => msgWitnesses.has(w))) {
          score += SCORE_WITNESS;
          via = "witness";
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
    if (score >= INTENT_MIN_SCORE) ranked.push({ program: p, score, via, idx: i });
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (b.program.sequence?.length ?? 0) - (a.program.sequence?.length ?? 0) ||
      a.idx - b.idx,
  );
  return ranked.map(({ idx: _idx, ...rest }) => rest);
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
 * MCP POST-transcript dispatch. Same scorer as local JIT — not a second ranker.
 * Shadow pick equals `selectSurfacePrograms({ mode: "jit", live, messages })`
 * on the same transcript + programs. Result length is 0 or 1.
 *
 * Missing / non-array messages, empty transcript, or a scorer fault → [].
 */
export function dispatchPrograms(
  messages: unknown[] | undefined,
  programs: StretchProgram[],
): StretchProgram[] {
  try {
    return selectSurfacePrograms({ mode: "jit", live: programs, messages }).surface.slice(0, 1);
  } catch {
    return [];
  }
}

/** JSON-RPC params: `{ messages }` or alias `{ transcript }`. A string `url` is one user turn. Non-arrays are missing. */
export function dispatchMessages(params?: Record<string, unknown> | null): unknown[] | undefined {
  if (!params || typeof params !== "object") return undefined;
  const raw = params.messages ?? params.transcript;
  if (Array.isArray(raw)) return raw;
  if (typeof params.url === "string" && params.url.trim()) {
    return [{ role: "user", content: params.url.trim() }];
  }
  return undefined;
}

/** Consecutive unused JIT injections before the episode demotes to S0 (none). */
export const JIT_UNUSED_DEMOTE = 3;

/**
 * Per-episode JIT bookkeeping. One of these lives on WrapState so inject,
 * the proxy response, and wrapTools share a conversion counter.
 */
export type JitGuard = {
  injections: number;
  unusedStreak: number;
  pendingName?: string;
  pendingAliases: string[];
  demoted: boolean;
};

export function createJitGuard(): JitGuard {
  return { injections: 0, unusedStreak: 0, pendingAliases: [], demoted: false };
}

/** The injected schema (or its first raw step) was actually called. */
export function noteJitUsed(jit: JitGuard, names: readonly string[]): void {
  if (!jit.pendingName) return;
  const hit = names.some((n) => n === jit.pendingName || jit.pendingAliases.includes(n));
  if (!hit) return;
  jit.pendingName = undefined;
  jit.pendingAliases = [];
  jit.unusedStreak = 0;
}

function toolNamesInMessages(messages?: unknown[]): string[] {
  const names: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (v == null || depth > 6 || names.length > 32) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const fn = o.function;
    if (fn && typeof fn === "object" && typeof (fn as { name?: unknown }).name === "string") {
      names.push((fn as { name: string }).name);
    }
    if (typeof o.name === "string" && (o.type === "function" || o.type === "tool_use")) {
      names.push(o.name);
    }
    for (const k of ["tool_calls", "content", "message"]) if (k in o) walk(o[k], depth + 1);
  };
  if (messages) walk(messages, 0);
  return names;
}

function settleJit(jit: JitGuard, messages?: unknown[]): boolean {
  if (jit.demoted) return true;
  if (jit.pendingName) {
    noteJitUsed(jit, toolNamesInMessages(messages));
  }
  if (jit.pendingName) {
    jit.unusedStreak++;
    jit.pendingName = undefined;
    jit.pendingAliases = [];
    if (jit.unusedStreak >= JIT_UNUSED_DEMOTE) {
      jit.demoted = true;
      return true;
    }
  }
  return jit.injections >= jitMax();
}

function recordJitInject(jit: JitGuard, program: StretchProgram): void {
  jit.injections++;
  jit.pendingName = program.name;
  const seq0 = (program.sequence ?? [])[0];
  jit.pendingAliases = seq0 && seq0 !== program.name ? [program.name, seq0] : [program.name];
}

/**
 * The one entry point request handlers call: reads EDEN_SURFACE, applies the
 * policy, logs shadow candidates. On any internal fault it degrades to the
 * historic full catalog — steering is unaffected either way, and a fat catalog
 * costs tokens while silence-by-crash starves the library silently.
 *
 * When mode is jit, `jit` caps injections per episode at jitMax() (EDEN_JIT_MAX,
 * default 4). Three consecutive unused injections demote the rest of the
 * episode to S0 (nothing surfaced).
 */
export function selectForRequest(
  live: StretchProgram[],
  messages?: unknown[],
  jit?: JitGuard,
): StretchProgram[] {
  let selected = live;
  try {
    const mode = surfaceMode();
    if (mode === "jit" && jit && settleJit(jit, messages)) return [];
    selected = selectSurfacePrograms({
      mode,
      live,
      messages,
      onShadow: (names) => console.error(`[eden] intent-shadow: would surface ${names.join(", ")}`),
    }).surface;
    if (mode === "jit" && jit && selected[0]) recordJitInject(jit, selected[0]);
  } catch {
    selected = live;
  }
  return selected;
}
