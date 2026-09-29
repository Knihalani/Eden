import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { opaqueId, scrubMemoryText } from "./memory-scrub";
import { isIclExemplar, objectAsserted, SemanticStore } from "./semantic-store";

function sessionKey(session: string): string {
  const s = String(session || "");
  return s ? opaqueId(s) : "";
}

export type Gist = {
  text: string;
  session: string;
  t: number;
  kind?: "session" | "hier";
  level?: number;
  src?: string;
  i?: number;
};

const TEXT_CAP = 800;

function gistKind(g: Gist): "session" | "hier" {
  return g.kind === "hier" ? "hier" : "session";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normObjKey(o: string): string {
  return o.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Positive instruction to use an object (`use X`, `Always use X`).
 * `Never` / `don't` are not the live choice and stay.
 */
function positiveUseObject(text: string): string | undefined {
  const raw = String(text ?? "").trim().replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
  if (!raw || /^(?:never|do not|don't)\b/i.test(raw)) return undefined;
  const m = raw.match(/^(?:(?:always|must|please)\s+)?(?:use|uses|using)\s+(.+)$/i);
  if (!m) return undefined;
  const o = m[1]!
    .replace(/\s+(?:instead of|rather than)\b.*$/i, "")
    .replace(/\s+(?:for|as|in|to|on)\s+.*$/i, "")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
  return o || undefined;
}

/**
 * Sleep gists are `stack uses postgres`, not `Use postgres`.
 * objectAsserted only sees a leading use/uses. Same (s, p) as the store.
 */
export function subjectUsesAsserted(text: string): { s: string; p: string; o: string } | undefined {
  try {
    const raw = String(text ?? "").trim().replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
    if (!raw || raw.endsWith("?") || isIclExemplar(raw)) return undefined;
    const m = raw.match(/^(?:the\s+)?([a-z][\w-]*)\s+uses\s+(\S(?:.*\S)?)$/i);
    if (!m) return undefined;
    const s = m[1]!.toLowerCase();
    const o = m[2]!
      .replace(/\s+(?:instead of|rather than)\b.*$/i, "")
      .replace(/\s+(?:for|as|in|to|on)\s+.*$/i, "")
      .replace(/[.,;:!?]+$/g, "")
      .trim();
    if (!s || !o || /^(?:the|a|an)$/i.test(s)) return undefined;
    return { s, p: "uses", o };
  } catch {
    return undefined;
  }
}

/** Keep a sentence's own terminator. Do not invent a second period. */
function joinKept(parts: string[]): string {
  let out = "";
  for (const p of parts) {
    if (!out) {
      out = p;
      continue;
    }
    out += /[.!?]$/.test(out) ? ` ${p}` : `. ${p}`;
  }
  return out.replace(/\s+/g, " ").replace(/\s+\./g, ".").trim();
}

/**
 * Drop sentences that assert a superseded object, and peel `instead of` /
 * `rather than` tails that name one. A live winner that uses the same string
 * (cache is postgres while database moved to sqlite) stays. Unrelated prose
 * and ICL that merely contain the dead string stay. Fail-open: returns the
 * original text if the semantic store cannot be read.
 */
export function scrubTombstonedIdentity(text: string, dir: string): string {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  try {
    if (!raw || typeof dir !== "string" || !dir.trim()) return raw;
    const store = new SemanticStore(dir);
    const dead = store.deadValues().map((o) => o.trim()).filter((o) => o.length >= 3);
    if (!dead.length) return raw;
    const deadKeys = new Set(dead.map((o) => normObjKey(o)));
    const liveObjs = new Set(store.live().map((r) => normObjKey(r.o)).filter((o) => o.length >= 3));
    let s = raw;
    for (const o of [...dead].sort((a, b) => b.length - a.length)) {
      s = s.replace(new RegExp(`\\s+(?:instead of|rather than)\\s+${escapeRe(o)}\\b`, "gi"), "");
    }
    s = s.replace(/\s+/g, " ").trim();
    const parts = s.split(/\s*(?:\|+|·)\s*|(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
    const kept: string[] = [];
    for (const part of parts.length ? parts : [s]) {
      const bare = part.replace(/^\[[a-z][a-z0-9_-]*(?:\s*·[^\]]*)?\]\s+/i, "");
      const fact = objectAsserted(bare) ?? subjectUsesAsserted(bare);
      // Same (s, p) only. A dead database object must not delete a live cache row.
      if (fact && store.supersededObject(fact.o, fact.s, fact.p)) continue;
      const used = positiveUseObject(bare);
      if (used) {
        const key = normObjKey(used);
        const stack = store.get("stack", "uses");
        // "Always use postgres" contradicts a live "use sqlite", even when a
        // different subject (the cache) still is postgres.
        if (stack && normObjKey(stack.o) !== key) continue;
        if (key.length >= 3 && deadKeys.has(key) && !liveObjs.has(key)) continue;
      }
      kept.push(part);
    }
    return joinKept(kept);
  } catch {
    return raw;
  }
}

function asGist(v: unknown): Gist | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text) return null;
  const gist: Gist = {
    text,
    session: typeof o.session === "string" ? o.session : "",
    t: typeof o.t === "number" && Number.isFinite(o.t) ? o.t : 0,
  };
  if (o.kind === "hier" || o.kind === "session") gist.kind = o.kind;
  if (typeof o.level === "number" && Number.isFinite(o.level)) gist.level = o.level;
  if (typeof o.src === "string" && o.src) gist.src = o.src;
  if (typeof o.i === "number" && Number.isFinite(o.i)) gist.i = o.i;
  return gist;
}

function load(path: string): Gist[] {
  if (!existsSync(path)) return [];
  const out: Gist[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const g = asGist(JSON.parse(line));
        if (g) out.push(g);
      } catch {
        // Torn or invalid line — skip.
      }
    }
  } catch {}
  return out;
}

function persist(path: string, rows: Gist[]): void {
  writeFileAtomic(path, rows.map((g) => JSON.stringify(g)).join("\n") + "\n");
  try { chmodSync(path, 0o600); } catch {}
}

/** GistStore: put(text, session, t); latest(session, k); replaceHier(nodes) */
export class GistStore {
  readonly dir: string;
  readonly path: string;
  private readonly lockPath: string;

  constructor(dir: string) {
    this.dir = dir;
    this.path = join(dir, "gists.jsonl");
    this.lockPath = `${this.path}.lock`;
  }

  /**
   * Session LWW. Does not delete hier rows. Missing kind on disk = session (M7/M25).
   * `src: "experience"` marks a replay gist so SessionStart can skip a traj dump.
   */
  put(text: string, session: string, t: number, src?: string): void {
    let body = scrubMemoryText(String(text || "").trim());
    try {
      const cleaned = scrubTombstonedIdentity(body, this.dir);
      if (typeof cleaned === "string") body = cleaned;
    } catch {}
    body = body.slice(0, TEXT_CAP);
    if (!body) return;
    const gist: Gist = {
      text: body,
      session: sessionKey(session),
      t: Number.isFinite(Number(t)) ? Number(t) : 0,
      kind: "session",
    };
    if (typeof src === "string" && src.trim()) gist.src = src.trim();
    try {
      withFileLock(this.lockPath, () => {
        const rows = load(this.path).filter((g) => gistKind(g) !== "session" || g.session !== gist.session);
        rows.push(gist);
        persist(this.path, rows);
      });
    } catch {
      // Fail-open: lock/disk faults must not throw into inject/sleep.
    }
  }

  /**
   * Session-kind only (missing kind = session). Never fills remaining slots from hier.
   * Empty session key → session-kind only, not a hier dump (SessionStart stays pins + session gists).
   * `excludeSrc`: skip those rows *before* the cap so experience replay cannot crowd out fact gists.
   */
  latest(session: string, k = 3, opts?: { excludeSrc?: string }): Gist[] {
    try {
      const cap = Math.max(0, Number(k) || 0);
      if (!cap) return [];
      const skip = typeof opts?.excludeSrc === "string" && opts.excludeSrc ? opts.excludeSrc : "";
      const sessionRows = load(this.path)
        .filter((g) => gistKind(g) === "session" && (!skip || g.src !== skip))
        .sort((a, b) => b.t - a.t);
      const key = sessionKey(session);
      if (!key) return sessionRows.slice(0, cap);
      const own = sessionRows.filter((g) => g.session === key);
      if (own.length >= cap) return own.slice(0, cap);
      const rest = sessionRows.filter((g) => g.session !== key);
      return [...own, ...rest].slice(0, cap);
    } catch {
      return [];
    }
  }

  /** Hier-only rows. SessionStart / latest() never return these. Fail-open. */
  hier(): Gist[] {
    try {
      return load(this.path).filter((g) => gistKind(g) === "hier");
    } catch {
      return [];
    }
  }

  /** Lock once, drop existing hier, keep session rows, append nodes, atomic write. Fail-open. */
  replaceHier(nodes: Gist[]): void {
    try {
      const incoming = Array.isArray(nodes) ? nodes : [];
      withFileLock(this.lockPath, () => {
        const sessionRows = load(this.path).filter((g) => gistKind(g) === "session");
        const hier: Gist[] = [];
        for (const n of incoming) {
          let text = scrubMemoryText(String(n?.text ?? "").trim());
          try {
            const cleaned = scrubTombstonedIdentity(text, this.dir);
            if (typeof cleaned === "string") text = cleaned;
          } catch {}
          if (!text) continue;
          const row: Gist = {
            text,
            session: sessionKey(typeof n.session === "string" ? n.session : ""),
            t: Number.isFinite(Number(n.t)) ? Number(n.t) : 0,
            kind: "hier",
          };
          if (typeof n.level === "number" && Number.isFinite(n.level)) row.level = n.level;
          if (typeof n.src === "string" && n.src) row.src = n.src;
          if (typeof n.i === "number" && Number.isFinite(n.i)) row.i = n.i;
          hier.push(row);
        }
        persist(this.path, [...sessionRows, ...hier]);
      });
    } catch {
      // Fail-open: lock/disk faults must not throw into inject/sleep.
    }
  }
}
