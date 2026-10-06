/**
 * SOTA hook helpers (docs/MEMORY-SOTA-BUILD-REPORT.md P0).
 * No embeddings, no dump-all, no LLM on submit.
 */

/** Every packet's header (D14, A4 §5.8). It names the scope once a scope catalog exists (P3.1). */
export const MEMORY_PACKET_MARK = "Eden memory, recalled from earlier sessions:";
/** Both headers a packet may carry: today's, and the one before P0.2, still in older conversations. */
export const MEMORY_PACKET_MARKS = [MEMORY_PACKET_MARK, "Eden Memory:"] as const;
export const PACKET_BULLET_MAX = 8;
export const PACKET_BYTE_CAP = 900;
export const PROCEDURE_TOKEN_CAP = 300;
export const PROCEDURE_CHAR_CAP = PROCEDURE_TOKEN_CAP * 4;
export const FACT_CHAR_CAP = PROCEDURE_CHAR_CAP;

export type HookLane = "copula" | "path" | "procedure" | "time" | "none";

const NOOP_EXACT = new RegExp(
  String.raw`^(?:ok|okay|thanks|thank you|got it|gotcha|nice|cool|will do|sure|yeah|yep|yup|lol|lmao|` +
    String.raw`asdf|qwerty|hi|hey|yo|continue|lgtm|ok go|sounds good|ship it|thx|ty|np|kk|` +
    String.raw`cheers)\s*[.!?]?\s*$`,
  "i",
);
const MATH_CUE = /^\s*(?:what(?:'s| is)\s+)?\d+\s*(?:\+|plus|\-|minus|\*|x|×|times|\/|÷|divided by)\s*\d+\s*\??\s*$/i;
const CONTENT_TERM = new RegExp(
  String.raw`\b(?:auth|sqlite|postgres|clerk|flake|commit|test|database|provider|session|file|src\/|\.ts|` +
    String.raw`\.py|adr|dlq|sqs|sidecar|istio|mesh)\b`,
  "i",
);

export function isNoopCue(cue: string): boolean {
  try {
    const t = String(cue ?? "").trim();
    if (!t) return true;
    if (CONTENT_TERM.test(t)) return false;
    const lower = t.toLowerCase();
    if (NOOP_EXACT.test(lower)) return true;
    if (MATH_CUE.test(lower)) return true;
    if (/\b(?:times|plus|minus|divided by)\b/.test(lower) && /\d/.test(lower) && lower.split(/\s+/).length <= 8) {
      return true;
    }
    const terms = lower.match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]{3,}/g) ?? [];
    if (!terms.length) return true;
    return false;
  } catch {
    return true;
  }
}

const PATH_NAME = /(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]+|[A-Za-z0-9._-]+\.[A-Za-z]{1,12}/;
const PLACE_PATH_KEYS = [
  "open_files",
  "openFiles",
  "files",
  "file_paths",
  "filePaths",
  "file_path",
  "filePath",
  "path",
  "filename",
  "file",
  "filepath",
  "recently_viewed_files",
  "recentlyViewedFiles",
] as const;
const PLACE_GOAL_KEYS = ["last_goal", "lastGoal", "current_goal", "currentGoal"] as const;
const PLACE_OBJ_KEYS = ["path", "file_path", "filePath", "filepath", "filename", "file", "uri", "name"] as const;
const PLACE_SKIP_KEYS = new Set([
  "cwd",
  "session_id",
  "sessionId",
  "sessionID",
  "email",
  "content",
  "body",
  "prompt",
  "text",
  "last_goal",
]);
const PLACE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PLACE_DOTTED = /^[A-Za-z0-9_-]+(?:\.[A-Za-z][A-Za-z0-9]*)+$/;
const PLACE_SEG = /^[A-Za-z0-9_.@+-]+$/;
const PLACE_CAP = 8;

function isPathish(raw: string): boolean {
  const t = String(raw ?? "").trim();
  if (!t || t.length > 240) return false;
  if (/\n/.test(t) || t.includes("@")) return false;
  if (/^(?:function|export|import|const|let|class|return)\b/.test(t)) return false;
  if (/[()]/.test(t)) return false;
  if (t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t)) return false;
  if (/^[A-Za-z0-9._-]+\.[A-Za-z]{1,12}$/.test(t)) return true;
  return PATH_NAME.test(t);
}

function basenamePath(p: string): string {
  const t = p.trim().replace(/\\/g, "/");
  const leaf = t.split("/").pop() || t;
  return leaf.toLowerCase();
}

export function pathCues(text: string): Set<string> {
  const out = new Set<string>();
  const s = String(text ?? "");
  const re = /[A-Za-z0-9._-]+\.[A-Za-z]{1,12}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const tok = m[0]!.toLowerCase();
    if (tok.includes("@")) continue;
    out.add(tok);
  }
  return out;
}

function placeLooksLikePath(s: string): boolean {
  const parts = s.split("/").filter(Boolean);
  if (!parts.length || !parts.every((p) => PLACE_SEG.test(p))) return false;
  return PLACE_DOTTED.test(parts[parts.length - 1] ?? "");
}

function placeCwdList(): string[] {
  const out: string[] = [];
  try {
    const n = process.cwd().trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (n.length >= 2) out.push(n);
  } catch {}
  return out;
}

function placePush(out: string[], name: string): void {
  const n = name.trim();
  if (!n || n.length > 120 || /[\r\n]/.test(n) || PLACE_EMAIL.test(n)) return;
  if (!isPathish(n) && !placeLooksLikePath(n)) return;
  const key = n.toLowerCase();
  if (out.some((x) => x.toLowerCase() === key) || out.length >= PLACE_CAP) return;
  out.push(n);
}

/** Basename plus a short relative path. Do not unique-only-by-basename (session.ts + src/lib/session.ts). */
function placeNamesFromString(raw: string, cwds: string[], out: string[]): void {
  let s = raw.trim();
  if (!s || s.length > 200 || /[\r\n]/.test(s) || PLACE_EMAIL.test(s) || /^cwd$/i.test(s)) return;
  s = s
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  try {
    if (s.includes("%")) s = decodeURIComponent(s);
  } catch {}
  if (!s || s.length > 200 || /[\r\n]/.test(s) || PLACE_EMAIL.test(s)) return;
  for (const c of cwds) {
    if (s.toLowerCase() === c.toLowerCase()) return;
    if (s.toLowerCase().startsWith(c.toLowerCase() + "/")) {
      s = s.slice(c.length).replace(/^\/+/, "");
      break;
    }
  }
  if (!s || s === "." || s === "..") return;
  if (s.startsWith("/") || /^[A-Za-z]:\//.test(s)) {
    const parts = s.split("/").filter(Boolean);
    if (!parts.every((p) => PLACE_SEG.test(p))) return;
    const base = parts[parts.length - 1] ?? "";
    if (PLACE_DOTTED.test(base)) placePush(out, base);
    return;
  }
  if (!placeLooksLikePath(s) && !isPathish(s)) return;
  const base = s.split("/").filter(Boolean).pop() ?? "";
  if (PLACE_DOTTED.test(base) || isPathish(base)) placePush(out, base);
  if (s.length <= 120 && s.includes("/") && s.toLowerCase() !== base.toLowerCase()) placePush(out, s);
}

function placeAddValue(v: unknown, cwds: string[], out: string[], depth: number): void {
  if (out.length >= PLACE_CAP || depth > 4) return;
  if (typeof v === "string") {
    if (/[,;]/.test(v) && !/[\r\n]/.test(v)) {
      for (const part of v.split(/[,;]/)) placeNamesFromString(part, cwds, out);
      return;
    }
    placeNamesFromString(v, cwds, out);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) placeAddValue(item, cwds, out, depth + 1);
    return;
  }
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  for (const k of PLACE_OBJ_KEYS) if (k in o) placeAddValue(o[k], cwds, out, depth + 1);
}

function placeAddGoal(text: string, out: string[]): void {
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return;
  try {
    for (const tok of pathCues(text.replace(PLACE_EMAIL, " "))) {
      if (out.length >= PLACE_CAP) return;
      if (!placeLooksLikePath(tok) && !isPathish(tok)) continue;
      placePush(out, tok);
    }
  } catch {}
}

function placeScan(o: Record<string, unknown>, cwds: string[], out: string[], depth: number): void {
  if (depth > 1) return;
  if (typeof o.cwd === "string") {
    const n = o.cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (n.length >= 2 && !cwds.some((x) => x.toLowerCase() === n.toLowerCase())) cwds.push(n);
  }
  for (const k of PLACE_PATH_KEYS) {
    if (PLACE_SKIP_KEYS.has(k)) continue;
    if (k in o) placeAddValue(o[k], cwds, out, 0);
  }
  for (const k of PLACE_GOAL_KEYS) if (typeof o[k] === "string") placeAddGoal(o[k], out);
  if (depth === 0) {
    for (const nest of ["context", "editor"] as const) {
      const child = o[nest];
      if (child && typeof child === "object" && !Array.isArray(child))
        placeScan(child as Record<string, unknown>, cwds, out, depth + 1);
    }
  }
}

/** Path names only. Never file bodies, cwd, emails, or transcript text. */
export function placePathsFrom(raw: unknown): string[] {
  try {
    const out: string[] = [];
    const cwds = placeCwdList();
    if (typeof raw === "string") {
      placeAddValue(raw, cwds, out, 0);
      return out;
    }
    if (Array.isArray(raw)) {
      placeAddValue(raw, cwds, out, 0);
      return out;
    }
    if (!raw || typeof raw !== "object") return [];
    placeScan(raw as Record<string, unknown>, cwds, out, 0);
    return out;
  } catch {
    return [];
  }
}

export function attachPlaceCues(cue: string, paths?: Iterable<string>): string {
  const base = typeof cue === "string" ? cue : "";
  try {
    const extra: string[] = [];
    const seen = new Set(pathCues(base));
    for (const p of paths ?? []) {
      const leaf = basenamePath(String(p));
      if (!leaf || seen.has(leaf)) continue;
      seen.add(leaf);
      extra.push(leaf);
    }
    return extra.length ? `${base} ${extra.join(" ")}`.trim() : base;
  } catch {
    return base;
  }
}

/** Rule/cue dates. Unparseable → undefined (caller skips the time lane). */
export function parseRuleTime(text: string): { at?: number; until?: number } | undefined {
  try {
    const t = String(text ?? "");
    if (!t.trim()) return undefined;
    const until = t.match(
      /\b(?:valid(?:_|\s+)?until|until|expires?(?:\s+on)?)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/i,
    );
    const asOf = t.match(/\b(?:as of|since|on|after|before)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/i);
    const iso = t.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const stamp = (raw: string): number | undefined => {
      const n = Date.parse(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    if (until) {
      const n = stamp(until[1]!);
      if (n == null) return undefined;
      return { until: n };
    }
    if (asOf) {
      const n = stamp(asOf[1]!);
      if (n == null) return undefined;
      return { at: n };
    }
    if (iso) {
      const n = stamp(iso[1]!);
      if (n == null) return undefined;
      return { at: n };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function hookLane(cue: string): HookLane {
  try {
    const t = String(cue ?? "").trim();
    if (!t || isNoopCue(t)) return "none";
    if (/\b(?:how to|howto|procedure|verify:|flake|fix failing)\b/i.test(t)) return "procedure";
    if (/\b(?:https?:\/\/|www\.)|\.[A-Za-z]{1,12}\b|\bsrc\/|\b[\w.-]+\/[\w.-]+/.test(t)) return "path";
    if (/\b(?:yesterday|last week|in 20\d{2})\b/i.test(t)) return "time";
    if (/\b(?:on|since|before|after|as of|until|valid_until)\b.+\b(?:20\d{2}|\d{1,2}\/\d{1,2})\b/i.test(t)) {
      if (parseRuleTime(t)) return "time";
    }
    if (/\b(?:is|are|was|were|uses?|provider|database)\b/i.test(t) || /\.[a-z]+=/i.test(t)) return "copula";
    if (CONTENT_TERM.test(t)) return "copula";
    return "copula";
  } catch {
    return "none";
  }
}

/** A packet's header line and the bullet lines under it, in either wording. */
const MEMORY_BLOCK = new RegExp(
  `(?:${MEMORY_PACKET_MARKS.map((mark) => mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})` +
    String.raw`[^\n]*(?:\n[ \t]*-[^\n]*)*`,
  "g",
);
const LABELED_LINE = /^\s*-\s+\[(?:fact|episode|rule|gist|procedure)[^\]]*\]\s+/gim;

export function stripMemoryPacket(text: string): string {
  try {
    let s = String(text ?? "");
    s = s.replace(MEMORY_BLOCK, "");
    s = s.replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/gi, "");
    s = s.replace(LABELED_LINE, "");
    return s.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return String(text ?? "");
  }
}

export type PackNote = { text: string; id?: string; kind?: string; at?: number; src?: string };

function looksCopula(text: string): boolean {
  const t = String(text ?? "")
    .replace(/^\s*-\s+/, "")
    .replace(/^\[[^\]]+\]\s+/, "");
  return /\b(?:is|are|was|were|uses?)\s+\S/.test(t) || /\s=\s/.test(t);
}

function packLine(n: PackNote): string {
  const body = String(n.text ?? "").trim();
  const src = typeof n.src === "string" ? n.src.trim() : "";
  const short = src && src.length <= 40 && !/\s/.test(src) && !/\n/.test(src) ? src : "";
  return short ? `- ${body} (${short})\n` : `- ${body}\n`;
}

/** Skip-not-evict. Never clip a copula. Oversized first copula is kept whole. */
export function packNotes(notes: PackNote[], byteCap = PACKET_BYTE_CAP, bulletMax = PACKET_BULLET_MAX): PackNote[] {
  const ranked = Array.isArray(notes) ? notes.filter((n) => n && String(n.text ?? "").trim()) : [];
  const header = `${MEMORY_PACKET_MARK}\n`;
  const picked: PackNote[] = [];
  let used = Buffer.byteLength(header, "utf8");
  for (const n of ranked) {
    if (picked.length >= bulletMax) break;
    const line = packLine(n);
    const nBytes = Buffer.byteLength(line, "utf8");
    if (used + nBytes > byteCap) {
      if (!picked.length && looksCopula(n.text)) {
        picked.push(n);
        break;
      }
      continue;
    }
    picked.push(n);
    used += nBytes;
  }
  return picked;
}

const PACK_STOP = new Set([
  "the",
  "of",
  "is",
  "a",
  "an",
  "on",
  "to",
  "and",
  "in",
  "for",
  "this",
  "that",
  "with",
  "from",
  "what",
  "why",
  "how",
  "who",
  "was",
  "are",
  "you",
  "your",
  "do",
  "we",
  "our",
  "use",
]);

function packBody(n: PackNote): string {
  return String(n.text ?? "")
    .replace(/^\s*-\s+/, "")
    .replace(/^\[[^\]]+\]\s+/, "")
    .toLowerCase();
}

/** Cue tokens that actually discriminate. Rarer in the retrieved set first. */
export function cueContentTokens(cue: string): string[] {
  const toks =
    String(cue ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]{3,}/g) ?? [];
  return [...new Set(toks.filter((t) => !PACK_STOP.has(t)))];
}

/**
 * Gold-first: notes that own the rarest cue token (copulas before episodes) pack first.
 * Does not pull from the rest of the store (dump-all stays gone).
 */
export function goldFirstNotes<T extends PackNote>(cue: string, notes: T[]): T[] {
  try {
    const ranked = Array.isArray(notes) ? notes.filter((n) => n && String(n.text ?? "").trim()) : [];
    if (ranked.length < 2) return ranked;
    const toks = cueContentTokens(cue);
    if (!toks.length) return ranked;
    const df = new Map<string, number>();
    for (const t of toks) {
      let c = 0;
      for (const n of ranked) if (packBody(n).includes(t) || (n.kind && String(n.kind).includes(t))) c++;
      df.set(t, c);
    }
    let rarest = toks[0]!;
    let best = Infinity;
    for (const t of toks) {
      const d = df.get(t) ?? 0;
      if (d > 0 && d < best) {
        best = d;
        rarest = t;
      }
    }
    if (!Number.isFinite(best) || best === Infinity) return ranked;
    const hit: T[] = [];
    const miss: T[] = [];
    for (const n of ranked) (packBody(n).includes(rarest) ? hit : miss).push(n);
    if (!hit.length) return ranked;
    const cop = (n: T) => looksCopula(n.text) || String(n.kind ?? "") === "fact";
    const sortHit = (a: T[], b: T[]) => [
      ...a.filter(cop),
      ...a.filter((n) => !cop(n)),
      ...b.filter(cop),
      ...b.filter((n) => !cop(n)),
    ];
    return sortHit(hit, miss);
  } catch {
    return Array.isArray(notes) ? notes : [];
  }
}

export const WRITE_ALIASES: Record<string, string[]> = {
  dlq: ["dead", "letters", "sqs"],
  sqs: ["dlq", "dead", "letters"],
  sidecar: ["mesh", "istio"],
  mesh: ["sidecar", "istio"],
  istio: ["sidecar", "mesh"],
};

/** Write-time entity tags. Tokens live on the row, not in CUE_EXPAND. */
export function writeAliasTags(tags: string[], text = ""): string[] {
  const set = new Set<string>();
  for (const t of tags ?? []) {
    const k = String(t ?? "")
      .toLowerCase()
      .trim();
    if (k) set.add(k);
  }
  const blob = String(text ?? "").toLowerCase();
  for (const w of blob.match(/[a-z0-9]+(?:[._-][a-z0-9]+)+|[a-z0-9]+/g) ?? []) set.add(w);
  if (
    set.has("dead-letters") ||
    set.has("dead_letters") ||
    set.has("deadletters") ||
    (set.has("dead") && set.has("letters"))
  ) {
    set.add("dlq");
    set.add("sqs");
  }
  for (const t of [...set]) {
    const extra = WRITE_ALIASES[t];
    if (extra) for (const x of extra) set.add(x);
  }
  return [...set];
}

export type MissClass = "Encode" | "Store" | "Retrieve" | "Maintain";

export type ObservationNote = { text?: string; kind?: string };

/** If a gist asserts (s,p), drop raw lines that contradict it. */
export function preferObservationOverSources<T extends ObservationNote>(notes: T[], gistTexts: string[]): T[] {
  try {
    if (!Array.isArray(notes) || !notes.length) return Array.isArray(notes) ? notes : [];
    const gists = (gistTexts ?? []).map((t) => String(t ?? "").trim()).filter(Boolean);
    if (!gists.length) return notes;
    const facts: { s: string; p: string; o: string }[] = [];
    for (const text of gists) {
      for (const seg of text.split(/(?:[.|]|\s+;\s+)/)) {
        const bare = seg.trim().replace(/^\[[^\]]+\]\s+/, "");
        if (!bare) continue;
        const use = bare.match(/^(?:the\s+)?([a-z][\w-]*)\s+uses\s+(\S.*)$/i);
        if (use) {
          facts.push({ s: use[1]!.toLowerCase(), p: "uses", o: use[2]!.replace(/[.,;:!?]+$/g, "").trim() });
          continue;
        }
        const m = bare.match(/^(?:the\s+)?(.{1,80}?)\s+(?:is|are)\s+(\S.*)$/i);
        if (m) {
          const s = m[1]!
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
          const o = m[2]!.replace(/[.,;:!?]+$/g, "").trim();
          if (s && o) facts.push({ s, p: "is", o });
        }
      }
    }
    if (!facts.length) return notes;
    return notes.filter((n) => {
      const k = String(n.kind ?? "").toLowerCase();
      if (k === "gist" || k === "digest") return true;
      const bare = String(n.text ?? "")
        .replace(/^\[[^\]]+\]\s+/, "")
        .trim();
      const use = bare.match(/^(?:the\s+)?([a-z][\w-]*)\s+uses\s+(\S.*)$/i);
      const m = use
        ? { s: use[1]!.toLowerCase(), p: "uses", o: use[2]!.replace(/[.,;:!?]+$/g, "").trim() }
        : (() => {
            const hit = bare.match(/^(?:the\s+)?(.{1,80}?)\s+(?:is|are)\s+(\S.*)$/i);
            if (!hit) return undefined;
            return {
              s: hit[1]!
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, " ")
                .trim(),
              p: "is",
              o: hit[2]!.replace(/[.,;:!?]+$/g, "").trim(),
            };
          })();
      if (!m?.s || !m.o) return true;
      const g = facts.find((f) => f.s === m.s && f.p === m.p);
      if (!g) return true;
      return g.o.replace(/\s+/g, " ").toLowerCase() === m.o.replace(/\s+/g, " ").toLowerCase();
    });
  } catch {
    return notes;
  }
}
