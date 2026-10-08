import { existsSync } from "node:fs";
import { join } from "node:path";
import { memoryNow } from "./memory-clock";
import { inStoreOrder } from "./memory-ids";
import { isIclExemplar, isRecsysShot, isToolProse, objectAsserted, SemanticStore } from "./semantic-store";

export type Triple = { s: string; p: string; o: string; t: number; recId?: string };

export type CandidateText = { text: string; t: number; id?: string; kind?: string; lane?: string };

type NoteLike = { id?: string; text: string; at?: number; seq?: number; kind?: string; lane?: string };

const STATUS_OBJECT = new RegExp(
  String.raw`\b(?:failing|broken|down|flaky|crashing|hanging|erroring|working|ready|live|dead|ok|fine|` +
    String.raw`slow|errors?|offline|unavailable)\b`,
  "i",
);
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

function asText(v: unknown): string {
  return v == null ? "" : String(v);
}

function finiteT(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normKeyPart(v: unknown): string {
  return asText(v).trim().toLowerCase().replace(/\s+/g, " ");
}

function spKey(s: string, p: string): string {
  return `${s}\0${p}`;
}

function oEq(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PACKET_DECOR_BODY = String.raw`\[(?:rule|fact|episode|gist|procedure)(?:\s*[·|][^\]]*)?\]\s+`;
const PACKET_DECOR_RE = new RegExp(`^${PACKET_DECOR_BODY}`, "i");

function stripPacketDecor(text: string): string {
  let t = asText(text)
    .trim()
    .replace(/^[-*]\s+/, "");
  for (let i = 0; i < 8; i++) {
    const next = t.replace(PACKET_DECOR_RE, "").trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/** A numbered list item ("8. The sport of Alice is basketball."): one piece, whatever sentences it holds. */
function isListItem(text: string): boolean {
  return /^\d+[.)]\s+\S/.test(stripPacketDecor(text));
}

function blockedKindOrLane(item: { kind?: string; lane?: string } | null | undefined): boolean {
  if (!item || typeof item !== "object") return false;
  const kind = asText(item.kind).trim().toLowerCase();
  const lane = asText(item.lane).trim().toLowerCase();
  return (
    kind === "icl" ||
    kind === "narrative" ||
    kind === "trajectory" ||
    kind === "recsys" ||
    lane === "icl" ||
    lane === "narrative" ||
    lane === "trajectory" ||
    lane === "recsys"
  );
}

function candidateFromNote(n: NoteLike, text?: string): CandidateText {
  const c: CandidateText = { text: asText(text ?? n.text), t: finiteT(n.at) ?? 0 };
  if (n.id != null && n.id !== "") c.id = n.id;
  if (n.kind != null && n.kind !== "") c.kind = n.kind;
  if (n.lane != null && n.lane !== "") c.lane = n.lane;
  return c;
}

/**
 * A heading over a numbered list ("Notes for this repo: 1. The database is sqlite 2. Logs go to stdout", its lines
 * joined): its items, each a statement of its own, so a later statement can supersede one (A5 `numbered-list`).
 * The items must count 1, 2, … so a number inside a sentence ("version 2. Then …") never splits one. The heading is
 * not a speaker label: no item carries it.
 */
export function listUnderHeading(text: string): string[] | undefined {
  const [heading, ...items] = text.trim().split(/\s+(?=\d{1,3}[.)]\s+\S)/);
  if (!heading?.endsWith(":") || items.length < 2) return undefined;
  return items.every((item, i) => item.startsWith(`${i + 1}.`) || item.startsWith(`${i + 1})`)) ? items : undefined;
}

export function splitNumberedItems(text: string): string[] {
  const t = asText(text).trim();
  if (!t) return [];
  try {
    const marks: number[] = [];
    const re = /\d+[.)]\s+\S/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const at = m.index;
      if (at === 0) {
        marks.push(0);
        continue;
      }
      const prev = t[at - 1];
      if (prev === "\n" || prev === "\r") {
        marks.push(at);
        continue;
      }
      if (prev && /\s/.test(prev)) {
        const before = t.slice(0, at).replace(/\s+$/, "");
        if (!before || /[.!?]$/.test(before)) marks.push(at);
      }
    }
    if (!marks.length) return [t];
    const parts: string[] = [];
    if (marks[0]! > 0) {
      const head = t.slice(0, marks[0]).trim();
      if (head) parts.push(head);
    }
    for (let i = 0; i < marks.length; i++) {
      const chunk = t.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : t.length).trim();
      if (chunk) parts.push(chunk);
    }
    return parts.length ? parts : [t];
  } catch {
    return [t];
  }
}

function sentencePieces(text: string): string[] {
  const one = asText(text).trim();
  if (!one) return [];
  if (isListItem(one)) return [one];
  const sents = one
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sents.length ? sents : [one];
}

function pieces(text: string): string[] {
  const t = asText(text).trim();
  if (!t) return [];
  const stripped = stripPacketDecor(t);
  const pipes = stripped
    .split(/\s+\|\s+/)
    .map((s) => stripPacketDecor(s))
    .filter(Boolean);
  const chunks = pipes.length ? pipes : [stripped];
  const out: string[] = [];
  for (const chunk of chunks) {
    const items = listUnderHeading(chunk) ?? splitNumberedItems(chunk);
    if (items.length > 1) {
      for (const item of items) out.push(...sentencePieces(item));
      continue;
    }
    out.push(...sentencePieces(items[0] ?? chunk));
  }
  return out;
}

function becameAsserted(text: string): { s: string; p: string; o: string } | undefined {
  let raw = asText(text).trim().replace(/\s+/g, " ");
  if (!raw || raw.endsWith("?") || isIclExemplar(raw) || isToolProse(raw)) return undefined;
  raw = raw.replace(/^\d+[.)]\s+/, "").replace(/^[.\s]+|[.\s]+$/g, "");
  const m = raw.match(/^(?:the\s+)?(.{1,120}?)\s+(became|becomes)\s+(\S.*)$/i);
  if (!m) return undefined;
  let s = m[1]!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  while (/^(?:the\s+|a\s+|an\s+)/.test(s)) s = s.replace(/^(?:the\s+|a\s+|an\s+)/, "");
  if (!s || SKIP_SUBJ.has(s)) return undefined;
  const o = m[3]!
    .replace(/\s+(?:instead of|rather than)\b.*$/i, "")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
  if (!o || STATUS_OBJECT.test(o)) return undefined;
  return { s, p: "is", o };
}

const DECIDED_RE = new RegExp(
  String.raw`\b(?:decided|chose|picked|went with|going with|settled on|opted for)\s+(?:to\s+)?` +
    String.raw`(?:use|go with)?\s*(.{1,40}?)\s+for\s+(.{1,40}?)(?=\s+(?:because|since|as|so)\b|[.,;:!?]|$)`,
  "gi",
);

function parseDecided(m: RegExpMatchArray): { s: string; p: string; o: string } | undefined {
  const o = m[1]!
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+(?:instead of|rather than)\b.*$/i, "")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
  let s = m[2]!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  while (/^(?:the\s+|a\s+|an\s+)/.test(s)) s = s.replace(/^(?:the\s+|a\s+|an\s+)/, "");
  if (!s || !o || SKIP_SUBJ.has(s) || STATUS_OBJECT.test(o)) return undefined;
  return { s, p: "is", o };
}

function decidedGuards(text: string): string | undefined {
  let raw = asText(text).trim().replace(/\s+/g, " ");
  if (!raw || raw.endsWith("?") || isIclExemplar(raw) || isToolProse(raw)) return undefined;
  if (/\bdon'?t forget\b/i.test(raw) || /\bdo not forget\b/i.test(raw)) return undefined;
  raw = raw.replace(/^\d+[.)]\s+/, "").replace(/^[.\s]+|[.\s]+$/g, "");
  return raw || undefined;
}

function decidedAll(text: string): { s: string; p: string; o: string }[] {
  const raw = decidedGuards(text);
  if (!raw) return [];
  const out: { s: string; p: string; o: string }[] = [];
  for (const m of raw.matchAll(DECIDED_RE)) {
    const parsed = parseDecided(m);
    if (parsed) out.push(parsed);
  }
  return out;
}

function decidedAsserted(text: string): { s: string; p: string; o: string } | undefined {
  return decidedAll(text)[0];
}

function assertedFromPiece(text: string): { s: string; p: string; o: string } | undefined {
  const cleaned = stripPacketDecor(text);
  if (!cleaned) return undefined;
  return objectAsserted(cleaned) ?? becameAsserted(cleaned) ?? decidedAsserted(cleaned);
}

function tripleFromPiece(piece: string, fallbackT: number, recId?: string): Triple | undefined {
  const cleaned = stripPacketDecor(piece);
  if (!cleaned || isIclExemplar(cleaned) || isIclExemplar(piece)) return undefined;
  const asserted = assertedFromPiece(cleaned);
  if (!asserted) return undefined;
  const t = fallbackT;
  if (!Number.isFinite(t)) return undefined;
  const s = normKeyPart(asserted.s);
  const p = normKeyPart(asserted.p);
  const o = asText(asserted.o).trim().replace(/\s+/g, " ");
  if (!s || !p || !o) return undefined;
  return recId ? { s, p, o, t, recId } : { s, p, o, t };
}

export function extractCandidates(texts: CandidateText[]): Triple[] {
  const out: Triple[] = [];
  try {
    if (!Array.isArray(texts)) return out;
    for (const item of texts) {
      try {
        if (!item || typeof item !== "object") continue;
        if (blockedKindOrLane(item)) continue;
        const text = asText((item as CandidateText).text);
        if (!text || isIclExemplar(text) || isRecsysShot(text)) continue;
        const fallback = finiteT((item as CandidateText).t) ?? 0;
        const id = (item as CandidateText).id;
        for (const piece of pieces(text)) {
          const decided = decidedAll(piece);
          if (decided.length > 1) {
            for (const asserted of decided) {
              const s = normKeyPart(asserted.s);
              const p = normKeyPart(asserted.p);
              const o = asText(asserted.o).trim().replace(/\s+/g, " ");
              if (!s || !p || !o) continue;
              out.push(id ? { s, p, o, t: fallback, recId: id } : { s, p, o, t: fallback });
            }
            continue;
          }
          const tr = tripleFromPiece(piece, fallback, id);
          if (tr) out.push(tr);
        }
      } catch {}
    }
  } catch {}
  return out;
}

export function assemble(triples: Triple[]): Triple[] {
  const best = new Map<string, Triple>();
  try {
    if (!Array.isArray(triples)) return [];
    for (const raw of triples) {
      try {
        if (!raw || typeof raw !== "object") continue;
        const s = normKeyPart(raw.s);
        const p = normKeyPart(raw.p);
        const o = asText(raw.o).trim().replace(/\s+/g, " ");
        const t = finiteT(raw.t);
        if (!s || !p || !o || t == null) continue;
        const k = spKey(s, p);
        const prev = best.get(k);
        if (!prev || t >= prev.t) {
          const next: Triple = { s, p, o, t };
          if (raw.recId != null && raw.recId !== "") next.recId = String(raw.recId);
          best.set(k, next);
        }
      } catch {}
    }
  } catch {}
  return [...best.values()];
}

export function losingTriples(triples: Triple[]): Triple[] {
  const out: Triple[] = [];
  try {
    if (!Array.isArray(triples)) return out;
    const winByKey = new Map<string, Triple>();
    for (const w of assemble(triples)) winByKey.set(spKey(w.s, w.p), w);
    const seen = new Set<string>();
    for (const raw of triples) {
      try {
        if (!raw || typeof raw !== "object") continue;
        const s = normKeyPart(raw.s);
        const p = normKeyPart(raw.p);
        const o = asText(raw.o).trim().replace(/\s+/g, " ");
        const t = finiteT(raw.t);
        if (!s || !p || !o || t == null) continue;
        const w = winByKey.get(spKey(s, p));
        if (!w || oEq(o, w.o)) continue;
        const id = `${s}\0${p}\0${o.trim().toLowerCase()}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const row: Triple = { s, p, o, t };
        if (raw.recId != null && raw.recId !== "") row.recId = String(raw.recId);
        out.push(row);
      } catch {}
    }
  } catch {}
  return out;
}

export function assemblyTWrite(liveT: number | undefined, winnerT: number, now?: number): number {
  const live = finiteT(liveT) ?? 0;
  const win = finiteT(winnerT) ?? 0;
  const n = finiteT(now) ?? memoryNow();
  const wall = Number.isFinite(n) ? n : 0;
  return Math.max(wall, live + 1, win);
}

function emitOne(store: SemanticStore, winner: Triple, losers: Triple[]): void {
  const live0 = store.get(winner.s, winner.p);
  const realLosers = losers.filter((l) => !oEq(l.o, winner.o));
  if (live0 && !oEq(live0.o, winner.o) && !realLosers.length) return;
  let pending = !live0 || !oEq(live0.o, winner.o);
  if (!pending) {
    for (const l of losers) {
      if (oEq(l.o, winner.o)) continue;
      if (!store.supersededObject(l.o, l.s, l.p)) {
        pending = true;
        break;
      }
    }
  }
  if (!pending) return;

  let tWrite = assemblyTWrite(live0?.t, winner.t);
  for (const l of losers) {
    if (oEq(l.o, winner.o)) continue;
    const live = store.get(winner.s, winner.p);
    if (live && oEq(live.o, l.o)) continue;
    if (store.supersededObject(l.o, l.s, l.p)) continue;
    tWrite = Math.max(tWrite, assemblyTWrite(live?.t, winner.t), l.t);
    store.put(l.s, l.p, l.o, tWrite);
  }

  tWrite = Math.max(tWrite, assemblyTWrite(store.get(winner.s, winner.p)?.t, winner.t));
  const live = store.get(winner.s, winner.p);
  if (live && !oEq(live.o, winner.o)) store.tombstone(winner.s, winner.p, Math.max(tWrite, live.t));
  store.put(winner.s, winner.p, winner.o, tWrite);
}

export function emitAssemblyTombstones(dir: string | undefined, triples: Triple[]): void {
  try {
    if (!dir || typeof dir !== "string" || !dir.trim()) return;
    if (!existsSync(dir)) return;
    if (!Array.isArray(triples) || !triples.length) return;
    const winners = assemble(triples);
    if (!winners.length) return;
    const lostByKey = new Map<string, Triple[]>();
    for (const l of losingTriples(triples)) {
      const k = spKey(l.s, l.p);
      const cur = lostByKey.get(k) ?? [];
      cur.push(l);
      lostByKey.set(k, cur);
    }
    const store = new SemanticStore(dir);
    store.beginBatch();
    try {
      for (const w of winners) {
        try {
          emitOne(store, w, lostByKey.get(spKey(w.s, w.p)) ?? []);
        } catch {}
      }
    } finally {
      try {
        store.endBatch();
      } catch {}
    }
  } catch {}
}

function liveStoreRows(dir: string | undefined, keys: Set<string>): Triple[] {
  const out: Triple[] = [];
  if (!dir || !keys.size) return out;
  try {
    if (!existsSync(join(dir, "semantic.jsonl"))) return out;
    const store = new SemanticStore(dir);
    for (const row of store.live()) {
      const k = spKey(normKeyPart(row.s), normKeyPart(row.p));
      if (!keys.has(k)) continue;
      const t = finiteT(row.t);
      const o = asText(row.o).trim().replace(/\s+/g, " ");
      if (t == null || !o) continue;
      out.push({ s: normKeyPart(row.s), p: normKeyPart(row.p), o, t });
    }
  } catch {}
  return out;
}

function packetLabelPrefix(text: string): string {
  const m = asText(text)
    .trim()
    .match(new RegExp(`^(${PACKET_DECOR_BODY})`, "i"));
  return m ? m[1]! : "";
}

function scrubLosing(text: string, losers: Map<string, string[]>, kind?: string, lane?: string): string {
  const raw = asText(text);
  if (!raw || !losers.size) return raw;
  if (blockedKindOrLane({ kind, lane })) return raw;
  if (isIclExemplar(raw)) return raw;
  const prefix = packetLabelPrefix(raw);
  const segs = pieces(raw);
  const kept: string[] = [];
  for (const seg of segs) {
    const tr = tripleFromPiece(seg, 0);
    if (tr) {
      const lose = losers.get(spKey(tr.s, tr.p));
      if (lose?.some((o) => oEq(o, tr.o))) continue;
    }
    let next = seg;
    if (tr) {
      const lose = losers.get(spKey(tr.s, tr.p));
      if (lose) {
        for (const o of lose) {
          if (!o) continue;
          const re = new RegExp(`\\s+(?:instead of|rather than)\\s+${escapeRe(o)}\\b.*$`, "i");
          next = next.replace(re, "").trim();
        }
      }
    }
    if (next) kept.push(next);
  }
  if (!kept.length) return "";
  if (kept.length === segs.length && kept.every((s, i) => s === segs[i])) return raw;
  const joined = raw.includes(" | ") ? kept.join(" | ") : kept.join(" ");
  if (prefix && !/^\[[a-z]/i.test(joined)) return prefix + joined;
  return joined;
}

export function assembleNotes<T extends NoteLike>(notes: T[], dir?: string): T[] {
  try {
    if (!Array.isArray(notes)) return [];
    const ordered = inStoreOrder(
      notes
        .filter((n) => n && typeof n === "object")
        .map((note) => ({ note, id: note.id ?? "", seq: note.seq, at: note.at })),
    );
    const fromNotes = extractCandidates(ordered.map(({ row, t }) => ({ ...candidateFromNote(row.note), t })));
    const keys = new Set<string>();
    for (const tr of fromNotes) keys.add(spKey(tr.s, tr.p));
    const extra = liveStoreRows(dir, keys);
    const winners = assemble([...fromNotes, ...extra]);
    const winByKey = new Map<string, Triple>();
    for (const w of winners) winByKey.set(spKey(w.s, w.p), w);

    const candidates = [...fromNotes, ...extra];
    const losers = new Map<string, string[]>();
    for (const tr of candidates) {
      const w = winByKey.get(spKey(tr.s, tr.p));
      if (!w || oEq(tr.o, w.o)) continue;
      const k = spKey(tr.s, tr.p);
      const cur = losers.get(k) ?? [];
      if (!cur.some((o) => oEq(o, tr.o))) cur.push(tr.o);
      losers.set(k, cur);
    }
    try {
      emitAssemblyTombstones(dir, candidates);
    } catch {}

    const out: T[] = [];
    for (const n of notes) {
      if (!n || typeof n !== "object") continue;
      const nextText = scrubLosing(asText(n.text), losers, n.kind, n.lane);
      if (!nextText) continue;
      const left = extractCandidates([candidateFromNote(n, nextText)]);
      if (left.length) {
        const loseOnly = left.every((tr) => {
          const w = winByKey.get(spKey(tr.s, tr.p));
          return !!(w && !oEq(tr.o, w.o));
        });
        if (loseOnly) continue;
      }
      out.push(nextText === n.text ? n : { ...n, text: nextText });
    }
    const proto = notes.find((n) => n && typeof n === "object");
    if (proto) {
      for (const w of winners) {
        const present = out.some((n) => {
          try {
            return extractCandidates([candidateFromNote(n)]).some(
              (tr) => spKey(tr.s, tr.p) === spKey(w.s, w.p) && oEq(tr.o, w.o),
            );
          } catch {
            return false;
          }
        });
        if (present) continue;
        const text = w.p === "uses" ? `${w.s} uses ${w.o}.` : `The ${w.s} is ${w.o}.`;
        out.push({ ...proto, id: `live:${w.s}:${w.p}`, text, at: w.t } as T);
      }
    }
    return out;
  } catch {
    return Array.isArray(notes) ? notes : [];
  }
}
