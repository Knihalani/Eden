import type { StretchProgram } from "@eden/ir";
import { jitMax } from "@eden/ir";
import { argShapes, firstCommandTemplate, programFirstStepShapes, templateFits } from "./steer";
import { looksLikeDenseWitness } from "../../core/src/shapes";

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

const SCORE_SHAPE = 4;
const SCORE_TEMPLATE = 3;
const SCORE_WITNESS = 3;
export const INTENT_MIN_SCORE = 3;

export type RankedMatch = {
  program: StretchProgram;
  score: number;
  via: "shape" | "template" | "witness" | "tokens";
};

type RankedInternal = RankedMatch & { idx: number };

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

const MSG_TEXT_KEYS = new Set(["content", "text", "command", "url", "thinking", "reasoning_content", "reasoning"]);

export function messageText(messages: readonly unknown[], maxMessages = 8): string {
  const parts: string[] = [];
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
      for (const key in o) if (MSG_TEXT_KEYS.has(key)) walk(o[key], depth + 1);
    }
  };
  const start = messages.length > maxMessages ? messages.length - maxMessages : 0;
  for (let i = start; i < messages.length; i++) walk(messages[i], 0);
  return parts.join("\n").slice(0, 16_000);
}

const DENSE_EXTRACT =
  /[^\s]+@[^\s]+|s3:\/\/[^\s]+|arn:aws:[^\s]+|gid:\/\/[^\s]+|\+[1-9]\d{6,14}|[A-Za-z0-9_.:/-]{4,}/g;

export function denseTokensFromText(text: string): Set<string> {
  const out = new Set<string>();
  const matches = text.match(DENSE_EXTRACT) ?? [];
  for (const raw of matches) {
    const t = raw.replace(/[.,;:!?)]+$/g, "");
    if (looksLikeDenseWitness(t)) out.add(t);
  }
  return out;
}

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
    const toks = new Set<string>();
    for (const t of informativeTokens(p.name || "")) toks.add(t);
    for (const n of p.sequence ?? []) for (const t of informativeTokens(n)) toks.add(t);
    for (const t of toks) {
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
  surface: StretchProgram[];
};

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
    return { surface: [] };
  }
  if (mode === "all") return { surface: live };
  let ranked: RankedMatch[] = [];
  try {
    ranked = msgs ? rankPrograms(msgs, live) : [];
  } catch {
    ranked = [];
  }
  const names = ranked.slice(0, 1).map((m) => m.program.name);
  if (mode === "jit-shadow") {
    if (names.length) onShadow?.(names);
    return { surface: [] };
  }
  return { surface: ranked.length ? [ranked[0]!.program] : [] };
}

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

export function dispatchMessages(params?: Record<string, unknown> | null): unknown[] | undefined {
  if (!params || typeof params !== "object") return undefined;
  const raw = params.messages ?? params.transcript;
  if (Array.isArray(raw)) return raw;
  if (typeof params.url === "string" && params.url.trim()) {
    return [{ role: "user", content: params.url.trim() }];
  }
  return undefined;
}

export const JIT_UNUSED_DEMOTE = 3;

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

export function noteJitUsed(jit: JitGuard, names: readonly string[]): void {
  if (!jit.pendingName) return;
  const hit = names.some((n) => n === jit.pendingName || jit.pendingAliases.includes(n));
  if (!hit) return;
  jit.pendingName = undefined;
  jit.pendingAliases = [];
  jit.unusedStreak = 0;
}

export function selectForRequest(
  live: StretchProgram[],
  messages?: unknown[],
  jit?: JitGuard,
): StretchProgram[] {
  let selected = live;
  try {
    const mode = surfaceMode();
    if (mode === "jit" && jit) {
      let settled = jit.demoted;
      if (!settled) {
        if (jit.pendingName) {
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
          noteJitUsed(jit, names);
        }
        if (jit.pendingName) {
          jit.unusedStreak++;
          jit.pendingName = undefined;
          jit.pendingAliases = [];
          if (jit.unusedStreak >= JIT_UNUSED_DEMOTE) {
            jit.demoted = true;
            settled = true;
          }
        }
        if (!settled) settled = jit.injections >= jitMax();
      }
      if (settled) return [];
    }
    selected = selectSurfacePrograms({
      mode,
      live,
      messages,
      onShadow: (names) => console.error(`[eden] intent-shadow: would surface ${names.join(", ")}`),
    }).surface;
    if (mode === "jit" && jit && selected[0]) {
      jit.injections++;
      jit.pendingName = selected[0].name;
      const seq0 = (selected[0].sequence ?? [])[0];
      jit.pendingAliases = seq0 && seq0 !== selected[0].name ? [selected[0].name, seq0] : [selected[0].name];
    }
  } catch {
    selected = live;
  }
  return selected;
}
