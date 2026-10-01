/**
 * MemoryAgentBench ingest units. The harness hands us 4096-token bags;
 * BrainMemory needs one episode per labeled example / numbered fact / ~512-token
 * narrative pack so BM25 can match the query to the right sentence.
 */

import { isRecsysShot } from "../../src/semantic-store.ts";

export type IngestKind = "icl" | "facts" | "narrative" | "recsys";

export type Atom = {
  text: string;
  session: number;
};

export type Atomized = {
  kind: IngestKind;
  atoms: Atom[];
};

const PACK_CHARS = 2000;
const MIN_ICL = 4;
const MIN_FACTS = 8;

export function atomize(blob: string): Atomized {
  const text = String(blob ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!text) return { kind: "narrative", atoms: [] };

  const iclN = countPat(text, /\nlabel:\s*\d+\s*(?:\n|$)/gi);
  if (iclN >= MIN_ICL) {
    const icl = splitIcl(text);
    if (icl.length >= MIN_ICL) {
      return {
        kind: "icl",
        atoms: icl.map((t, i) => ({ text: t, session: i })),
      };
    }
  }

  let recsys = false;
  try {
    recsys = isRecsysShot(text);
  } catch {
    recsys = false;
  }
  if (recsys) {
    const packs = splitRecsys(text);
    return {
      kind: "recsys",
      atoms: packs.map((t, i) => ({ text: t, session: Math.floor(i / 3) })),
    };
  }

  const facts = splitFacts(text);
  if (facts.length >= MIN_FACTS && consecutiveEnough(facts.map((f) => f.serial))) {
    return {
      kind: "facts",
      atoms: facts.map((f) => ({ text: f.text, session: f.serial })),
    };
  }

  const packs = packSentences(text, PACK_CHARS);
  return {
    kind: "narrative",
    atoms: packs.map((t, i) => ({ text: t, session: Math.floor(i / 3) })),
  };
}

function countPat(text: string, re: RegExp, cap = 32): number {
  let n = 0;
  re.lastIndex = 0;
  while (n < cap && re.exec(text)) n++;
  return n;
}

export function splitIcl(blob: string): string[] {
  const re = /([\s\S]*?)\nlabel:\s*(\d+)\s*(?:\n|$)/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob))) {
    const raw = m[1]!.replace(/^(?:here is (?:a list of )?(?:the )?(?:examples?|facts)[^\n]*\n)?/i, "");
    const utt = raw
      .split(/\n{2,}/)
      .pop()!
      .replace(/\s+/g, " ")
      .trim();
    if (utt.length < 4) continue;
    out.push(`${utt}\nlabel: ${m[2]}`);
  }
  return out;
}

export function splitFacts(blob: string): { serial: number; text: string }[] {
  const parts = blob.split(/(?:^|\n)(?=\d+\.\s)/);
  const out: { serial: number; text: string }[] = [];
  for (const p of parts) {
    const m = p.trim().match(/^(\d+)\.\s+([\s\S]+)$/);
    if (!m) continue;
    const body = m[2]!.replace(/\s+/g, " ").trim();
    if (body.length < 8) continue;
    out.push({ serial: Number(m[1]), text: `${m[1]}. ${body}` });
  }
  return out;
}

function consecutiveEnough(serials: number[]): boolean {
  if (serials.length < 2) return false;
  let consec = 0;
  for (let i = 1; i < serials.length; i++) if (serials[i] === serials[i - 1]! + 1) consec++;
  return consec >= serials.length * 0.7;
}

function packChunks(parts: string[], maxChars: number): string[] {
  const packs: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && cur.length + 1 + p.length > maxChars) {
      packs.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
  }
  if (cur) packs.push(cur);
  return packs;
}

function splitRecsys(blob: string): string[] {
  const speakers = blob
    .split(/(?:^|\n)(?=(?:User|System)\s*:)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (speakers.length >= 2) return packChunks(speakers, PACK_CHARS);
  return packSentences(blob, PACK_CHARS);
}

export function packSentences(blob: string, maxChars: number): string[] {
  const sents = blob
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sents.length) return blob.trim() ? [blob.trim()] : [];
  const packs: string[] = [];
  let cur = "";
  for (const s of sents) {
    if (cur && cur.length + 1 + s.length > maxChars) {
      packs.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) packs.push(cur);
  return packs;
}
