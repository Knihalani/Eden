/**
 * English forget on the observe chat lane. Tombstones matching identity and
 * drops the JSONL rows sleep would replay. Never throws into inject/observe.
 */
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { scrubTombstonedIdentity, subjectUsesAsserted } from "./gist-store";
import { memoryConsent, memoryWritesAllowed } from "./memory-consent";
import { isIclExemplar, objectAsserted, SemanticStore } from "./semantic-store";

/** don't / do not / never / can't / cannot forget — not a tombstone. */
const FORGET_NEGATION = /\b(?:don'?t|do\s+not|never|can(?:not|'t))\s+forget\b/i;

type MemRow = { id: string; text: string; kind: string; sal?: number; lane?: string };

export type ForgetHost = {
  dir: string;
  /** Child episodic writer. Root SemanticStore is only tombstoned from a parent (non-child) observe. */
  child?: boolean;
  /** Sanitized session. Parent name is the segment before `--`. */
  session?: string;
  /** Episodic jsonl directory (child suffix when `child`). */
  jsonlDir?: string;
  dropWhere?(pred: (r: MemRow) => boolean): void;
  memories?(): MemRow[];
  semantic?(): {
    live(): { s: string; p: string; o: string; t: number }[];
    tombstone(s: string, p: string, t: number): void;
    get?(s: string, p: string): { o: string } | undefined;
    supersededObject?(o: string, s?: string, p?: string): boolean;
  };
};

function writesAllowed(): boolean {
  try {
    if (typeof memoryWritesAllowed === "function") return memoryWritesAllowed();
    return memoryConsent() === "on";
  } catch {
    return false;
  }
}

function cleanCue(raw: string): string | null {
  let s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/[.,;:!?]+$/g, "").trim();
  s = s.replace(/^(?:about\s+)+/i, "").trim();
  while (/^(?:the|a|an)\s+/i.test(s)) s = s.replace(/^(?:the|a|an)\s+/i, "").trim();
  s = s.replace(/[.,;:!?]+$/g, "").trim();
  s = s.split(/\s+(?:for|please|now|thanks|to|from)\b/i)[0]?.trim() ?? "";
  s = s.replace(/[.,;:!?]+$/g, "").trim();
  if (!s || /^(?:the|a|an|about)$/i.test(s)) return null;
  return s;
}

/**
 * Cue of a forget utterance, or null (false positive / empty).
 * Negation: don't forget / do not forget / never forget / can't forget / cannot forget.
 * Past-only "forgot" is not an imperative.
 */
export function forgetCueFrom(text: string): string | null {
  try {
    const raw = String(text ?? "")
      .replace(/[\u2018\u2019\u02bc\uff07]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (!raw) return null;
    if (FORGET_NEGATION.test(raw)) return null;
    const stopped = raw.match(/\bstop\s+using\s+(.+?)(?=[.!?]|$)|\b(?:don'?t|do\s+not)\s+use\s+(.+?)\s+anymore\b/i);
    const forgot = raw.match(
      /\b(?:please\s+)?forget(?:\s+about)?\s+(\S(?:.*?\S)?)(?=[.!?]|$)|\b(?:please\s+)?forget(?:\s+about)?\s+(\S+)\b/i,
    );
    const pastOnly = /\bforgot\b/i.test(raw) && !/\bforget\b/i.test(raw) && !stopped;
    if (pastOnly) return null;
    const captured = (stopped?.[1] || stopped?.[2] || forgot?.[1] || forgot?.[2] || "").trim();
    if (!captured) return null;
    return cleanCue(captured);
  } catch {
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive exact trim, or cue as a whole token inside o. */
function objectMatchesCue(o: string, cue: string): boolean {
  const a = String(o ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  const c = String(cue ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!a || !c) return false;
  if (a === c) return true;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(c)}(?![a-z0-9])`, "i").test(a);
}

function positiveUseObject(text: string): string | undefined {
  const raw = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");
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

function pinned(r: MemRow): boolean {
  return r.kind === "constraint" || (typeof r.sal === "number" && r.sal >= 0.6);
}

function shouldDrop(r: MemRow, cue: string): boolean {
  const text = String(r?.text ?? "");
  if (!text || !r.id) return false;
  try {
    if (r.lane === "icl" || isIclExemplar(text)) return false;
  } catch {
    return false;
  }
  let fact: { s: string; p: string; o: string } | undefined;
  try {
    fact = objectAsserted(text);
  } catch {
    fact = undefined;
  }
  if (fact && objectMatchesCue(fact.o, cue)) {
    // Drop the asserting row even if the tombstone file has not replayed yet.
    // Sleep put() would otherwise resurrect postgres over an observe tombstone.
    return true;
  }
  const stated = subjectUsesAsserted(text);
  if (stated && objectMatchesCue(stated.o, cue)) return true;
  const used = positiveUseObject(text);
  if (used && objectMatchesCue(used, cue)) return true;
  if (r.kind === "constraint" && objectMatchesCue(text, cue)) return true;
  if (!pinned(r) && r.kind === "episode" && objectMatchesCue(text, cue)) return true;
  return false;
}

function hostIsChild(mem: ForgetHost): boolean {
  return mem?.child === true;
}

function dropCueRows(mem: ForgetHost, cue: string): void {
  if (typeof mem.dropWhere !== "function" || typeof mem.memories !== "function") return;
  const ids = new Set<string>();
  for (const r of mem.memories()) {
    try {
      if (shouldDrop(r, cue)) ids.add(r.id);
    } catch {}
  }
  if (ids.size) mem.dropWhere((r) => ids.has(r.id));
}

function tombstoneRoot(mem: ForgetHost, dir: string, cue: string): void {
  const store = mem.semantic?.() ?? new SemanticStore(dir);
  const t = Date.now();
  let live: { s: string; p: string; o: string }[] = [];
  try {
    live = store.live();
  } catch {
    live = [];
  }
  for (const row of live) {
    try {
      if (objectMatchesCue(row.o, cue)) store.tombstone(row.s, row.p, t);
    } catch {}
  }
  try {
    const stack = store.get?.("stack", "uses");
    if (stack && objectMatchesCue(stack.o, cue)) store.tombstone("stack", "uses", t);
  } catch {}
  try {
    rewriteGists(dir);
  } catch {}
}

function rewriteGists(dir: string): void {
  const path = join(dir, "gists.jsonl");
  if (!existsSync(path)) return;
  withFileLock(`${path}.lock`, () => {
    const kept: string[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      let row: { text?: string; kind?: string } | null = null;
      try {
        row = JSON.parse(line) as { text?: string; kind?: string };
      } catch {
        kept.push(line);
        continue;
      }
      if (!row || typeof row.text !== "string") {
        kept.push(line);
        continue;
      }
      // Hier rows are retrieved on summarize. Scrub them too so a forgotten
      // name cannot ride back in as `stack uses postgres`.
      let text = row.text;
      try {
        const cleaned = scrubTombstonedIdentity(text, dir);
        if (typeof cleaned === "string") text = cleaned;
      } catch {}
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      kept.push(JSON.stringify({ ...row, text }));
    }
    writeFileAtomic(path, kept.length ? `${kept.join("\n")}\n` : "");
    try {
      chmodSync(path, 0o600);
    } catch {}
  });
}

/**
 * Tombstone live (s,p) whose object matches the cue and drop JSONL identity
 * rows so sleep cannot put() the object back. Returns true when the utterance
 * is a forget (caller must skip extractDurable). False = not a forget / no-op.
 */
export function applyObserveForget(mem: ForgetHost, role: string, text: string): boolean {
  try {
    // The human steers memory in English. Assistant chatter is not a forget.
    if (role && role !== "user") return false;
    if (!writesAllowed()) return false;
    const cue = forgetCueFrom(text);
    if (!cue) return false;
    try {
      const dir = String(mem?.dir ?? "");
      if (!dir) return true;
      if (hostIsChild(mem)) {
        // Child writes stay in the child JSONL. Root SemanticStore is the parent's
        // unless the parent session itself observed the forget (non-child path).
        try {
          dropCueRows(mem, cue);
        } catch {}
      } else {
        try {
          tombstoneRoot(mem, dir, cue);
        } catch {}
        try {
          dropCueRows(mem, cue);
        } catch {}
      }
    } catch {}
    return true;
  } catch {
    return false;
  }
}
