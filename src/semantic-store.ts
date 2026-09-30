/**
 * Product semantic store: typed KV with time + tombstone.
 * Last-write-wins on (s, p, o, valid_from). Old rows are absent, not ×0.45 muted.
 * Not src/cls/semantic.ts (copula compile). Extraction is sleep.ts; this module stores.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { scrubMemoryText } from "./memory-scrub";

export type SemanticTriple = { s: string; p: string; o: string; t: number };

type Row = {
  s: string;
  p: string;
  o: string;
  t: number;
  tombstone?: boolean;
  seq: number;
};

const STATUS_OBJECT =
  /\b(?:failing|broken|down|flaky|crashing|hanging|erroring|working|ready|live|dead|ok|fine|slow|errors?|offline|unavailable)\b/i;
const SKIP_SUBJ = new Set([
  "it",
  "this",
  "that",
  "there",
  "here",
  "he",
  "she",
  "they",
  "we",
  "i",
  "you",
  "one",
  "what",
  "who",
  "which",
]);
/** Wrap/hook synthetic tool turns — experience, not identity. */
const TOOL_PROSE = /^(?:the\s+\S+\s+tool result is |tool\s+\S+\s+(?:result is|was called))/i;

function normS(s: string): string {
  let x = String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  // Numbered facts leak "8. The chairperson…" into s; strip serial + articles so LWW shares a key.
  x = x.replace(/^\d+\s+/, "");
  while (/^(?:the|a|an)\s+/.test(x)) x = x.replace(/^(?:the|a|an)\s+/, "");
  return x;
}

function normP(p: string): string {
  return String(p ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normO(o: string): string {
  return String(o ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function oEq(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
}

function isStatusObject(obj: string): boolean {
  return STATUS_OBJECT.test(obj);
}

/** Fact-list serials are small ints. Observe/emit wall-clock is ~1e12. */
const WALL_CLOCK_T = 1e11;

function isSerialT(t: number): boolean {
  return Number.isFinite(t) && t < WALL_CLOCK_T;
}

/** Serial overwrite may replace a wall-clock live/tombstone even when t is smaller. */
function serialOverWall(incoming: number, existing: number): boolean {
  return isSerialT(incoming) && Number.isFinite(existing) && existing >= WALL_CLOCK_T;
}

export class SemanticStore {
  readonly dir: string;
  readonly path: string;
  private readonly lockPath: string;
  private rows: Row[] = [];
  private seq = 0;
  /** Nested quiet()/beginBatch: apply in memory, one locked write on endBatch. */
  private hold = 0;
  private dirtyBatch = false;
  /** Ops applied during hold. endBatch replays them onto a fresh disk load. */
  private batchOps: Array<
    { kind: "put"; s: string; p: string; o: string; t: number } | { kind: "tomb"; s: string; p: string; t: number }
  > = [];

  constructor(dir: string) {
    this.dir = dir;
    this.path = join(dir, "semantic.jsonl");
    this.lockPath = `${this.path}.lock`;
    try {
      mkdirSync(dir, { recursive: true });
      try {
        chmodSync(dir, 0o700);
      } catch {}
    } catch {}
    this.load();
  }

  /** Defer disk until matching endBatch. Nested. Same triples; not a ranker change. */
  beginBatch(): void {
    this.hold++;
  }

  /** Nested with beginBatch: one locked write after fn. Fail-open. */
  quiet(fn: () => void): void {
    this.beginBatch();
    try {
      fn();
    } finally {
      this.endBatch();
    }
  }

  endBatch(): void {
    if (this.hold > 0) this.hold--;
    if (this.hold > 0 || !this.dirtyBatch) return;
    const ops = this.batchOps;
    try {
      withFileLock(this.lockPath, () => {
        this.rows = [];
        this.seq = 0;
        this.load();
        for (const op of ops) {
          if (op.kind === "put") this.applyPut(op.s, op.p, op.o, op.t);
          else this.applyTomb(op.s, op.p, op.t);
        }
        writeFileAtomic(this.path, this.serialize());
        try {
          chmodSync(this.path, 0o600);
        } catch {}
      });
      this.batchOps = [];
      this.dirtyBatch = false;
    } catch {
      this.dirtyBatch = true;
    }
  }

  put(s: string, p: string, o: string, t: number): void {
    const ns = normS(scrubMemoryText(s)),
      np = normP(scrubMemoryText(p)),
      no = normO(scrubMemoryText(o));
    if (!ns || !np || !no || !Number.isFinite(t)) return;
    const apply = () => this.applyPut(ns, np, no, t);
    if (this.hold > 0) {
      this.batchOps.push({ kind: "put", s: ns, p: np, o: no, t });
      apply();
      this.dirtyBatch = true;
      return;
    }
    this.mutate(apply);
  }

  tombstone(s: string, p: string, t: number): void {
    const ns = normS(s),
      np = normP(p);
    if (!ns || !np || !Number.isFinite(t)) return;
    const apply = () => this.applyTomb(ns, np, t);
    if (this.hold > 0) {
      this.batchOps.push({ kind: "tomb", s: ns, p: np, t });
      apply();
      this.dirtyBatch = true;
      return;
    }
    this.mutate(apply);
  }

  private applyPut(ns: string, np: string, no: string, t: number): void {
    const live = this.replay(ns, np);
    if (live) {
      if (oEq(live.o, no)) {
        if (t > live.t || serialOverWall(t, live.t)) {
          const row = this.liveRow(ns, np);
          if (row) row.t = serialOverWall(t, live.t) ? t : Math.max(row.t, t);
        }
        return;
      }
      // Unnumbered wall-clock must not demote a live serial winner (M21 basketball).
      if (isSerialT(live.t) && !isSerialT(t)) return;
      if (t < live.t && !serialOverWall(t, live.t)) return;
      const old = this.liveRow(ns, np);
      if (old) {
        old.tombstone = true;
        old.t = serialOverWall(t, live.t) ? live.t : t;
      }
    } else {
      const last = this.lastEvent(ns, np);
      if (last?.tombstone && t < last.t && !serialOverWall(t, last.t)) return;
    }
    this.rows.push({ s: ns, p: np, o: no, t, seq: this.seq++ });
  }

  private applyTomb(ns: string, np: string, t: number): void {
    const live = this.replay(ns, np);
    if (live && t < live.t) return;
    const row = this.liveRow(ns, np);
    if (row) {
      row.tombstone = true;
      row.t = t;
    } else {
      const last = this.lastEvent(ns, np);
      if (last?.tombstone && last.t >= t) return;
      this.rows.push({ s: ns, p: np, o: "", t, tombstone: true, seq: this.seq++ });
    }
  }

  get(s: string, p: string): SemanticTriple | undefined {
    return this.replay(normS(s), normP(p));
  }

  /** All currently live (non-tombstoned) triples, newest t wins per (s, p). */
  live(): SemanticTriple[] {
    const seen = new Set<string>();
    const out: SemanticTriple[] = [];
    for (const row of this.rows) {
      const k = `${row.s}\0${row.p}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = this.replay(row.s, row.p);
      if (cur) out.push(cur);
    }
    return out.sort((a, b) => a.t - b.t || a.s.localeCompare(b.s) || a.p.localeCompare(b.p));
  }

  /** Object values that are not the live row for their (s, p). */
  deadValues(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of this.rows) {
      if (!row.o || row.o.length < 3) continue;
      const cur = this.replay(row.s, row.p);
      if (cur && oEq(cur.o, row.o)) continue;
      const k = row.o.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(row.o);
    }
    return out;
  }

  /** True if this object value is superseded/tombstoned for its (s, p). */
  supersededObject(o: string, s?: string, p?: string): boolean {
    const obj = normO(o);
    if (!obj) return false;
    const ns = s != null ? normS(s) : undefined;
    const np = p != null ? normP(p) : undefined;
    for (const row of this.rows) {
      if (!row.o || !oEq(row.o, obj)) continue;
      if (ns != null && row.s !== ns) continue;
      if (np != null && row.p !== np) continue;
      const cur = this.replay(row.s, row.p);
      if (!cur || !oEq(cur.o, obj)) return true;
    }
    return false;
  }

  private liveRow(s: string, p: string): Row | undefined {
    const cur = this.replay(s, p);
    if (!cur) return undefined;
    let found: Row | undefined;
    for (const row of this.rows) {
      if (row.s !== s || row.p !== p || row.tombstone) continue;
      if (!oEq(row.o, cur.o)) continue;
      if (!found || row.t > found.t || (row.t === found.t && row.seq > found.seq)) found = row;
    }
    return found;
  }

  private lastEvent(s: string, p: string): Row | undefined {
    let found: Row | undefined;
    for (const row of this.rows) {
      if (row.s !== s || row.p !== p) continue;
      if (!found || row.t > found.t || (row.t === found.t && row.seq > found.seq)) found = row;
    }
    return found;
  }

  private replay(s: string, p: string): SemanticTriple | undefined {
    if (!s || !p) return undefined;
    const ev = this.rows.filter((r) => r.s === s && r.p === p);
    const byT = (a: Row, b: Row) => a.t - b.t || a.seq - b.seq;
    // Wall-clock first, then fact-list serials. Serial overwrite must outrank
    // Date.now() rows that would otherwise sort after t=8 and wipe the winner.
    const walls = ev.filter((e) => e.t >= WALL_CLOCK_T).sort(byT);
    const serials = ev.filter((e) => e.t < WALL_CLOCK_T).sort(byT);
    let cur: SemanticTriple | undefined;
    for (const e of [...walls, ...serials]) {
      if (e.tombstone) cur = undefined;
      else cur = { s: e.s, p: e.p, o: e.o, t: e.t };
    }
    return cur;
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line) as Partial<Row>;
          const s = normS(String(rec?.s ?? ""));
          const p = normP(String(rec?.p ?? ""));
          const t = Number(rec?.t);
          if (!s || !p || !Number.isFinite(t)) continue;
          const tombstone = rec?.tombstone === true;
          const o = normO(String(rec?.o ?? ""));
          if (!tombstone && !o) continue;
          this.rows.push({ s, p, o, t, tombstone: tombstone || undefined, seq: this.seq++ });
        } catch {
          // Torn or invalid line — skip.
        }
      }
    } catch {}
  }

  private serialize(): string {
    return (
      this.rows
        .map((r) =>
          JSON.stringify({
            s: r.s,
            p: r.p,
            o: r.o,
            t: r.t,
            ...(r.tombstone ? { tombstone: true } : {}),
          }),
        )
        .join("\n") + (this.rows.length ? "\n" : "")
    );
  }

  /** Reload disk under the lock so two SemanticStore instances cannot clobber each other. */
  private mutate(fn: () => void): void {
    try {
      withFileLock(this.lockPath, () => {
        this.rows = [];
        this.seq = 0;
        this.load();
        fn();
        writeFileAtomic(this.path, this.serialize());
        try {
          chmodSync(this.path, 0o600);
        } catch {}
      });
    } catch {
      // Fail-open: lock/disk faults must not throw into inject/sleep.
    }
  }
}

/**
 * Minimal identity-copula / "use X" extractor for sleep tests.
 * Status objects ("Auth is failing") are not identity — returns undefined.
 */
export function objectAsserted(text: string): { s: string; p: string; o: string } | undefined {
  let raw = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!raw || raw.endsWith("?") || isIclExemplar(raw) || isToolProse(raw)) return undefined;
  raw = raw.replace(/^\d+[.)]\s+/, "").replace(/^[.\s]+|[.\s]+$/g, "");
  const pin = raw.match(/^(?:please\s+)?pin\s+([A-Za-z][\w-]*)/i);
  if (pin) return { s: pin[1]!.toLowerCase(), p: "is", o: pin[1]! };
  raw = raw.replace(/^(?:always|never|must|from now on)\s+/i, "");
  const use = raw.match(/^(?:(?:we|i|you|they)\s+(?:are\s+)?)?(?:use|uses|using)\s+(.+)$/i);
  if (use) {
    const o = use[1]!
      .replace(/\s+(?:instead of|rather than)\b.*$/i, "")
      .replace(/\s+instead$/i, "")
      .replace(/\s+(?:for|as|in|to|on)\s+.*$/i, "")
      .replace(/[.,;:!?]+$/g, "")
      .trim();
    if (!o || isStatusObject(o)) return undefined;
    return { s: "stack", p: "uses", o };
  }
  const m = raw.match(/^(?:the\s+)?(.{1,120}?)\s+(is\s+now|are\s+now|was|were|is|are)\s+(\S.*)$/i);
  if (!m) return undefined;
  let s = m[1]!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  while (/^(?:the|a|an)\s+/.test(s)) s = s.replace(/^(?:the|a|an)\s+/, "");
  if (!s || SKIP_SUBJ.has(s)) return undefined;
  const o = m[3]!
    .replace(/\s+(?:instead of|rather than)\b.*$/i, "")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
  if (!o || isStatusObject(o)) return undefined;
  return { s, p: "is", o };
}

/** ICL exemplars must not be put() into the store. Sleep should skip these.
 * `label:` or an input:/output: *pair*. Split MCC `Input: The film is terrible.`
 * (film/movie, no Output: on this turn) is still ICL. Lone `Output:` is DetQA.
 * Coding `Input: src/auth.ts` is not ICL — even with `Output:` or `film` in a path.
 */
function inputHead(text: string): string {
  const m = String(text ?? "").match(/\binput\s*:\s*([^\n]+)/i);
  return m ? m[1]!.trim() : "";
}

function looksCodeInput(text: string): boolean {
  const v = inputHead(text);
  if (!v) return false;
  if (/[\\/]/.test(v)) return true;
  if (
    /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|kts|c|cc|cpp|h|hpp|cs|php|swift|m|mm|json|ya?ml|toml|md|txt|sql|sh|bash|zsh)\b/i.test(
      v,
    )
  )
    return true;
  if (/^src\b/i.test(v)) return true;
  return false;
}

export function isIclExemplar(text: string): boolean {
  try {
    const t = String(text ?? "")
      .replace(/^\s*(?:\d+[.)]\s+|[>\-*]+\s+)*/, "")
      .trim();
    if (/\blabel\s*:/i.test(t)) return true;
    const codeIn = looksCodeInput(t);
    if (/\binput\s*:/i.test(t) && /\boutput\s*:/i.test(t) && !codeIn) return true;
    if (/\binput\s*:/i.test(t) && /\b(?:film|movie)\b/i.test(t) && !codeIn) return true;
    return false;
  } catch {
    return false;
  }
}

const TITLE_YEAR_RE = /[A-Za-z0-9][^()\n]{0,80}\((?:19|20)\d{2}\)/g;
const NUMBERED_MOVIE_RE = /^\s*\d+[.)]\s+\S.*\((?:19|20)\d{2}\)\s*$/;
const RECSYS_PROMPT_RE = /\bmovie recommender\b|\brecommend movies\b/i;
const HERE_CONV_RE = /here is the conversation:/i;
const SPEAKER_RE = /\b(?:user|system)\s*:/i;
const MOVIE_VOCAB_RE = /\b(?:movies?|films?|watched|watching|recommend(?:ed|ing|er|s)?|liked)\b/i;
const LIKE_RE = /\blike[ds]?\b/i;
const NUMBERED_LINE_RE = /^\s*\d+[.)]\s+/;
const COPULA_RE = /\b(?:is|are|was|were|uses)\b/i;
const DOC_ID_RE = /\b(?:RFC|ISO|CVE|IEEE|W3C|PEP)\s*[-.]?\s*\d/i;
const VERSION_TITLE_RE =
  /\b(?:Node|Python|TypeScript|JavaScript|React|Vue|Angular|Java|Ruby|PHP|Go|Rust|Swift|Kotlin|Scala|Perl|Deno|Bun)\s+v?\d/i;

function countTitleYears(t: string, cap = 8): number {
  TITLE_YEAR_RE.lastIndex = 0;
  let n = 0;
  while (n < cap && TITLE_YEAR_RE.exec(t)) n++;
  return n;
}

function looksIdentityList(t: string): boolean {
  const lines = t.split(/\n/).filter((l) => NUMBERED_LINE_RE.test(l));
  if (lines.length < 2) return false;
  let copula = 0;
  for (const l of lines) {
    if (COPULA_RE.test(l)) copula++;
  }
  return copula >= 2 && copula * 2 >= lines.length;
}

function looksVersionish(t: string): boolean {
  if (DOC_ID_RE.test(t) || VERSION_TITLE_RE.test(t)) return true;
  if (/\b(?:v?\d+\.\d+)(?:\.\d+)?\s*\((?:19|20)\d{2}\)/.test(t)) return true;
  return false;
}

function isNumberedMovieLine(l: string): boolean {
  if (!NUMBERED_MOVIE_RE.test(l)) return false;
  if (COPULA_RE.test(l) || looksVersionish(l)) return false;
  return true;
}

/** Flattened `1. Superbad (2007) 2. Hangover (2009)` — not chairperson copulas. */
function countNonCopulaNumberedTitleYears(t: string, cap = 8): number {
  const re = /\d+[.)]\s+([^\n]*?)\((?:19|20)\d{2}\)/g;
  let n = 0;
  let m: RegExpExecArray | null;
  while (n < cap && (m = re.exec(t))) {
    const body = `${m[1] ?? ""}${m[0]}`;
    if (COPULA_RE.test(m[1] ?? "") || looksVersionish(body)) continue;
    n++;
  }
  return n;
}

function looksMovieTitleList(t: string): boolean {
  if (looksIdentityList(t) || looksVersionish(t) || COPULA_RE.test(t)) return false;
  const parts = t
    .split(/\s*,\s*|\n/)
    .map((s) => s.trim().replace(/^and\s+/i, ""))
    .filter(Boolean);
  if (parts.length < 2) return false;
  let n = 0;
  for (const p of parts) {
    TITLE_YEAR_RE.lastIndex = 0;
    if (!TITLE_YEAR_RE.test(p)) continue;
    if (COPULA_RE.test(p) || looksVersionish(p)) return false;
    n++;
  }
  return n >= 2;
}

function hasMovieLikeTitleYear(t: string): boolean {
  // Title run immediately before (YYYY): "Superbad", "The Hangover", "Knocked Up".
  // Not "I like postgres (2019)" (lowercase product) or "Node 18 (2022)".
  const re = /(?:^|[\s,;])((?:The\s+)?[A-Z][A-Za-z0-9'&:.-]*(?:\s+[A-Z][A-Za-z0-9'&:.-]*){0,5})\s*\((?:19|20)\d{2}\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const title = (m[1] ?? "").trim();
    if (!title || looksVersionish(m[0]!) || /\b\d+\.\d+\b/.test(title)) continue;
    if (/^(?:User|System|I|We|You)$/i.test(title)) continue;
    return true;
  }
  return false;
}

/** ReDial / numbered movie lists. ICL, chairperson copulas, coding years stay false. Fail-open: false. */
export function isRecsysShot(text: string): boolean {
  try {
    const t = String(text ?? "").trim();
    if (!t) return false;
    if (isIclExemplar(t)) return false;
    if (looksIdentityList(t) && !MOVIE_VOCAB_RE.test(t)) return false;
    const years = countTitleYears(t);
    if (RECSYS_PROMPT_RE.test(t)) return true;
    if (HERE_CONV_RE.test(t) && SPEAKER_RE.test(t) && MOVIE_VOCAB_RE.test(t)) return true;
    if (MOVIE_VOCAB_RE.test(t) && years >= 1) return true;
    let numbered = 0;
    for (const l of t.split(/\n/)) if (isNumberedMovieLine(l) && ++numbered >= 2) return true;
    if (countNonCopulaNumberedTitleYears(t) >= 2) return true;
    if (years >= 2 && looksMovieTitleList(t)) return true;
    if (SPEAKER_RE.test(t) && MOVIE_VOCAB_RE.test(t)) return true;
    if (SPEAKER_RE.test(t) && LIKE_RE.test(t) && years >= 1 && !looksVersionish(t) && hasMovieLikeTitleYear(t))
      return true;
    return false;
  } catch {
    return false;
  }
}

/** Wrap/hook "Tool X result is …" / "The X tool result is …" — not an identity copula. */
export function isToolProse(text: string): boolean {
  return TOOL_PROSE.test(
    String(text ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** True if sleep should drop this episode text (asserted object is gone). */
export function supersededText(store: SemanticStore, text: string): boolean {
  const a = objectAsserted(text);
  if (!a) return false;
  return store.supersededObject(a.o, a.s, a.p);
}
