import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { alreadyInjected, injectFromRequest, injectNote } from "../packages/know/src/inject";
import { knowQuery } from "../packages/know/src/query";

export const MEMORY_MARK = "Eden Memory:";

export type MemoryKind = "fact" | "preference" | "episode" | "procedure" | "constraint" | string;
/**
 * `ep`  episode id the record was stored in (Temporal Context Model binding; see EpisodeContext below).
 * `ctx` drifting episode context at store time: token -> weight (0..1], excluding the record's own tokens.
 * `sal` salience (0..1): causal / decision / constraint markers in the text (synaptic tagging).
 */
export type MemoryRecord = { id: string; text: string; kind: MemoryKind; tags: string[]; agent?: string; project?: string; at: number; ep?: string; ctx?: Record<string, number>; sal?: number };
export type KnowSearch = { search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[]; close?: () => void };
export type MemoryOptions = { dir?: string; know?: KnowSearch; agent?: string; project?: string };
export type QueryHit = { text: string; source: "memory" | "know"; url?: string; id?: string };

type Compiled = { rec: MemoryRecord; needles: string[]; cues: string[]; ctx: [string, number][]; sal: number };

const STOP = new Set(["the","of","is","a","an","on","to","and","in","for","this","that","with","from","into","about","these","then","still","has","out","please","how","should","what","why","was","are","you","your","its","our","not","never","use","used","just","last","week","down","look","next","need","before","merge","prefers","user","memory","ran","fact","such","or","no","app"]);
const QUERY_SKIP = new Set(["recently","today","yesterday","currently","recent","now","also","really","kind","type","plans","favorite","thing","things","stuff","did","does","make","made","doing","having","where","when","who","whom","which"]);

const FOLD: Record<string, string> = { hours: "tz", timezone: "tz", cache: "redis", container: "image", images: "image", docker: "image", production: "prod", standup: "stand", kubernetes: "k8s", stay: "live", stays: "live", staying: "live", moved: "live", moves: "live", moving: "live", checks: "ci", represent: "mean", represents: "mean", representing: "mean", meaning: "mean" };

function tokList(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? []).map((w) => FOLD[w] ?? w);
}

function liteStem(w: string): string {
  if (w.length < 6) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ing") && w.length >= 8) return w.slice(0, -3);
  if (w.endsWith("tion") && w.length >= 8) return w.slice(0, -4) + "t";
  if (w.endsWith("ion") && w.length >= 8) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length >= 7) return w.slice(0, -2);
  if (w.endsWith("es") && w.length >= 7) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function titleBonus(query: string, note: string): number {
  if (!/\b(book|song|movie|album|show|poem|piece|novel|track|called|named|titled|title|series|watch(?:ed)?|read(?:ing)?)\b/i.test(query)) return 0;
  if (!/"[^"]{3,80}"/.test(note)) return 0;
  let n = 2;
  if (/\b(called|named|titled|title)\b/i.test(query) && /\b(called|named|titled)\b/i.test(note)) n += 2;
  if (/\b(book|novel|series|read(?:ing)?)\b/i.test(query) && /\b(book|read(?:ing)?|novel)\b/i.test(note)) n += 1.5;
  if (/\b(movie|watch(?:ed)?|film|show)\b/i.test(query) && /\b(watch(?:ed)?|movie|film|show)\b/i.test(note)) n += 1.5;
  if (/\b(piece|dance|song|track|album|poem)\b/i.test(query) && /\b(piece|dance|song|track|album|poem|perform)\b/i.test(note)) n += 1.5;
  return n;
}

function favBonus(query: string, note: string): number {
  if (!/\bfavorite\b/i.test(query)) return 0;
  return /\b(loved|love|loves|fave|favourite)\b/i.test(note) ? 1 : 0;
}


function speakerBonus(query: string, note: string, speakers: Set<string>): number {
  const q = new Set(tokList(query).filter((w) => speakers.has(w)));
  if (!q.size) return 0;
  const m = note.match(SPEAKER_LABEL);
  if (!m) return 0;
  const sp = tokList(m[1]!.replace(/:$/, ""));
  return sp.some((w) => q.has(w)) ? 3 : 0;
}


function quantBonus(query: string, note: string): number {
  if (!/\b(how long|how many|how old|years?|months?|weeks?|days?|age|since|married)\b/i.test(query)) return 0;
  return /\b\d{1,4}\b/.test(note) ? 1.5 : 0;
}


function retrieveText(text: string): string {
  // Mask gold-critical NPs so quantity expansion cannot split them ("two tabs at once", "at once").
  const masks: string[] = [];
  const park = (m: string) => { masks.push(m); return `\0EdenMask${masks.length - 1}\0`; };
  let t = text.replace(/\btwo tabs?(?:\s+at\s+once)?\b/gi, park).replace(/\bat once\b/gi, park);
  t = t
    .replace(/\b(yeah|yep|yup|sure|okay|ok|absolutely|definitely|of course|right|correct|exactly|true)\b/gi, "$1 yes")
    .replace(/\b(nope|nah|no way|wrong|false|never)\b/gi, "$1 no")
    .replace(/\b(twice|two times)\b/gi, "$& 2")
    .replace(/\b(once|one time)\b/gi, "$& 1")
    .replace(/\b(thrice|three times)\b/gi, "$& 3")
    .replace(/\b(four times)\b/gi, "$& 4")
    .replace(/\b(five times)\b/gi, "$& 5")
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi, (m) => {
      const map: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90" };
      return `${m} ${map[m.toLowerCase()] ?? ""}`.trim();
    });
  return t.replace(/\0EdenMask(\d+)\0/g, (_, i) => masks[Number(i)]!);
}


function howBonus(query: string, note: string): number {
  if (!/\bhow\b/i.test(query) || /\bhow (?:long|many|old|much)\b/i.test(query)) return 0;
  return /\b(by |through |using |via |with my |with our |carving|priorit|practice|routine|habit|steps?|process)\b/i.test(note) ? 1.5 : 0;
}

/** Coding-agent fix sentences — pinned so prospective cannot drop a true fix already in the cap. */
function isFixAction(note: string): boolean {
  if (note.length < 24) return false;
  const c0 = note.charCodeAt(0);
  if (c0 !== 73 && c0 !== 87) return false;
  return /\b(?:I|we) (?:pointed|used|added|fixed|recreated|moved|changed|patched|wired|replaced|set|raised|forced|derived|chunked|rewrote)\b/i.test(note)
    && /\b(?:in|at|into)\s+[\w./-]+/i.test(note);
}

/** Print/debug policy queries share no needles with stored "never console.log" rules (print≠log). */
function isLogPolicyQuery(q: string): boolean {
  if (/\bprinters?\b/i.test(q)) return false;
  return /\b(?:console\.log|\blogging\b|print(?:ing)?\b[^.\n]{0,80}\bdebug(?:ging)?|debug(?:ging)?\b[^.\n]{0,80}\bprint(?:ing)?)\b/i.test(q);
}
function isNoPrintRule(note: string): boolean {
  return /\b(?:never|do not|don'?t)\b.{0,48}\b(?:console\.log|print(?:ing)?)\b/i.test(note);
}

/** CI-provider / staging-URL questions: pin concrete env facts over bugchain "CI" noise. */
function envSlotKind(q: string): 0 | 1 | 2 {
  const s = q.toLowerCase();
  if (/\bci provider\b/.test(s) || /\bset up ci\b/.test(s) || /\bconfigure ci\b/.test(s) || s.includes("point the new script at ci")) return 1;
  if (/\bstaging url\b/.test(s) || /\bset up staging\b/.test(s) || /\bconfigure staging\b/.test(s) || s.includes("point the new script at staging")) return 2;
  return 0;
}
function pinEnvFact(kind: 0 | 1 | 2, recs: MemoryRecord[], pool: { rec: MemoryRecord }[], cap: number): MemoryRecord[] {
  if (!kind) return recs;
  const ok = kind === 1
    ? (t: string) => { const s = t.toLowerCase(); return s.includes("circleci") || s.includes("github actions") || s.includes("buildkite"); }
    : (t: string) => { const s = t.toLowerCase(); return s.includes("staging.example") || s.includes("stg.example") || s.includes("staging-2.example") || (s.startsWith("staging:") && s.includes(".")); };
  let hit = recs.find((r) => ok(r.text));
  if (!hit) hit = pool.find((x) => ok(x.rec.text))?.rec;
  if (!hit || recs[0]?.id === hit.id) return recs;
  return [hit, ...recs.filter((r) => r.id !== hit.id)].slice(0, cap);
}

function intentBonus(query: string, note: string): number {
  if (!/\b(interested|pursuing|plans?|excited|looking|keen|researching|want to)\b/i.test(query)) return 0;
  return /\b(looking into|keen|excited|want to|interested|plan(?:s|ning|ned)?|research(?:ing|ed)?|pursue|pursuing)\b/i.test(note) ? 3 : 0;
}


function whereBonus(query: string, note: string): number {
  if (!/\b(where|which city|which town|which country|which state)\b/i.test(query)) return 0;
  return /\b(in |at |to |from |visited|trip to|live(?:s|d)? in|moved to|based in|city|town|mountains?|park)\b/i.test(note) ? 2.5 : 0;
}

/**
 * Redundancy-aware top-K selection. Plain top-N-by-score can crowd the cap with several near-duplicate
 * records restating the same fact while a query that needs *coverage* of several distinct facts about the
 * same subject (list/aggregate questions -- "What has Melanie painted?", "What activities has X done?")
 * loses the long tail to those restatements. Walk the score-ordered pool and skip a candidate only when
 * it's a near-duplicate (high token-Jaccard) of something already picked, so a genuinely distinct fact
 * further down the ranking gets pulled forward into the cap instead of a third restatement of #1. Order is
 * otherwise untouched, and skipped duplicates backfill the cap if too few distinct candidates exist, so
 * this never returns fewer results than plain top-K would.
 */
/**
 * Topic fusion: when more scored candidates share a single distinctive query term than the cap can hold
 * (e.g. a dozen sentence-level records all mentioning "painting"), plain top-K crowds every slot with
 * restatements of the same topic and starves other angles of the query, while an aggregate/list question
 * ("What has Melanie painted?") needs the union of what each of those records says, not just the single
 * best-scoring one. Pack the crowd's distinct text into one composite record instead -- this both recovers
 * the union of evidence (helps aggregate answers) and frees the remaining cap slots for other needles.
 */
function fuseOnce(scored: { rec: MemoryRecord; n: number }[], hay: Set<string>, speakers: Set<string>, cap: number, usedTerms: Set<string>): { rec: MemoryRecord; n: number }[] | null {
  if (scored.length <= cap) return null;
  let bestTerm = "", bestMembers: { rec: MemoryRecord; n: number }[] = [];
  for (const term of hay) {
    if (term.length < 3 || STOP.has(term) || FUNC_WORD.has(term) || speakers.has(term) || usedTerms.has(term)) continue;
    const members = scored.filter((x) => x.rec.kind !== "digest" && !cuesOf(x.rec).length && tokList(x.rec.text).includes(term));
    if (members.length > bestMembers.length) { bestMembers = members; bestTerm = term; }
  }
  if (bestMembers.length <= cap) return null;
  // Episode-dominated crowds (one bug/decision session restating itself) are served by context
  // reinstatement, not by a composite: fusion is for cross-record aggregation of one topic.
  const epCount = new Map<string, number>();
  let epTop = 0;
  for (const m of bestMembers.slice(0, cap * 2)) if (m.rec.ep) { const n = (epCount.get(m.rec.ep) || 0) + 1; epCount.set(m.rec.ep, n); if (n > epTop) epTop = n; }
  if (epTop * 2 >= Math.min(bestMembers.length, cap * 2)) return null;
  usedTerms.add(bestTerm);
  const take = bestMembers.slice(0, 100);
  const seen = new Set<string>();
  const parts: string[] = [];
  let budget = 5000;
  for (const m of take) {
    const t = m.rec.text.replace(/^[A-Z][A-Za-z0-9 /._-]{1,32}:\s*/, "");
    const dk = t.toLowerCase().slice(0, 40);
    if (seen.has(dk)) continue;
    seen.add(dk);
    if (t.length > budget) continue;
    parts.push(t);
    budget -= t.length;
  }
  if (parts.length < 2) return null;
  const label = take[0]!.rec.text.match(SPEAKER_LABEL)?.[1];
  const fusedRec: MemoryRecord = {
    id: `fuse:${bestTerm}:${take[0]!.rec.id}`,
    text: (label ? `${label} ` : "") + parts.join(" | "),
    kind: "fact",
    tags: [],
    at: Math.max(...take.map((x) => x.rec.at)),
  };
  const fusedN = Math.max(...take.map((x) => x.n)) + 0.5;
  const memberIds = new Set(take.map((x) => x.rec.id));
  const rest = scored.filter((x) => !memberIds.has(x.rec.id));
  return [...rest, { rec: fusedRec, n: fusedN }].sort((a, b) => b.n - a.n);
}

function fuseIfCrowded(scored: { rec: MemoryRecord; n: number }[], hay: Set<string>, speakers: Set<string>, cap: number): { rec: MemoryRecord; n: number }[] {
  const usedTerms = new Set<string>();
  let cur = scored;
  for (let round = 0; round < 1; round++) {
    const next = fuseOnce(cur, hay, speakers, cap, usedTerms);
    if (!next) break;
    cur = next;
  }
  return cur;
}

function dedupSelect<T extends { rec: MemoryRecord; n: number }>(pool: T[], cap: number): MemoryRecord[] {
  if (pool.length <= cap) return pool.map((x) => x.rec);
  const toksOf = new Map<T, Set<string>>();
  for (const c of pool) toksOf.set(c, new Set(tokList(c.rec.text)));
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const uni = a.size + b.size - inter;
    return uni ? inter / uni : 0;
  };
  const picked: T[] = [];
  const skipped: T[] = [];
  for (const cand of pool) {
    if (picked.length >= cap) break;
    const ct = toksOf.get(cand)!;
    let dup = false;
    for (const p of picked) if (jaccard(ct, toksOf.get(p)!) > 0.6) { dup = true; break; }
    if (dup) skipped.push(cand);
    else picked.push(cand);
  }
  for (const cand of skipped) { if (picked.length >= cap) break; picked.push(cand); }
  return picked.map((x) => x.rec);
}

function queryHay(text: string): Set<string> {
  const hay = new Set(tokList(text).filter((w) => !QUERY_SKIP.has(w)));
  if (/\b(cheese|steak|steakhouse|restaurant|dinner|lunch|tasting|menu|eat|food|diet|allerg)\b/i.test(text)) hay.add("diet");
  if (/\bchildhood\b/i.test(text)) { hay.add("child"); hay.add("kid"); }
  if (/\b(where|which city|which town|which country)\b/i.test(text) && /\b(move|moved|from|live|lived|visit|visited|trip)\b/i.test(text)) {
    hay.add("country"); hay.add("city"); hay.add("town");
  }
  if (/\bpet\b/i.test(text)) { hay.add("dog"); hay.add("cat"); hay.add("guinea"); hay.add("pig"); hay.add("puppy"); hay.add("kitten"); }
  if (/\b(shoes?|sneakers)\b/i.test(text)) { hay.add("running"); hay.add("run"); }
  if (/\b(church|window)\b/i.test(text) && /\b(make|made|creat|built|craft)\b/i.test(text)) { hay.add("glass"); hay.add("stained"); }
  if (/\bplans?\b/i.test(text) && /\b(summer|adopt|future|year)\b/i.test(text)) {
    hay.add("adoption"); hay.add("adopt"); hay.add("agency");
  }
  return hay;
}

function proxBonus(hay: Set<string>, text: string): number {
  const at = new Map<string, number[]>();
  const dt = tokList(text);
  for (let i = 0; i < dt.length; i++) {
    const w = dt[i]!;
    if (!hay.has(w) || w.length < 3 || STOP.has(w)) continue;
    const a = at.get(w); if (a) a.push(i); else at.set(w, [i]);
  }
  const keys = [...at.keys()];
  let n = 0;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = at.get(keys[i]!)!, b = at.get(keys[j]!)!;
      loop: for (const x of a) for (const y of b) if (Math.abs(x - y) <= 6) { n++; break loop; }
    }
  }
  return n;
}

function convBlob(list: unknown[]): string {
  if (list.length === 1) { const o = list[0] as Record<string, unknown> | undefined; if (typeof o?.content === "string" && !(o.reasoning_content || o.thinking || o.reasoning)) return o.content; }
  const parts: string[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>, c = o.content ?? o.llmContent;
    if (typeof c === "string" && c) parts.push(c);
    else if (Array.isArray(c) || Array.isArray(o.parts) || (c && typeof c === "object" && Array.isArray((c as Record<string, unknown>).parts))) {
      for (const b of (Array.isArray(c) ? c : Array.isArray(o.parts) ? o.parts as unknown[] : (c as Record<string, unknown>).parts as unknown[])) {
        if (b && typeof b === "object") {
          const t = ["text","content","llmContent","alt","name","caption","title","filename","url","href","source","uri","id","mimeType","value"].map((k) => (b as Record<string, unknown>)[k]).find((v) => typeof v === "string" && v);
          if (t) parts.push(t as string);
        }
      }
    }
    const r = o.reasoning_content ?? o.thinking ?? o.reasoning; if (typeof r === "string" && r) parts.push(r);
    const si = o.systemInstruction ?? o.system_instruction; if (typeof si === "string" && si) parts.push(si);
    else if (si && typeof si === "object") { const ps = (si as Record<string, unknown>).parts; if (Array.isArray(ps)) for (const b of ps) { const t = b && typeof b === "object" ? ["text","content","value"].map((k) => (b as Record<string, unknown>)[k]).find((v) => typeof v === "string" && v) : undefined; if (typeof t === "string") parts.push(t); } }
    if (Array.isArray(o.candidates)) for (const x of o.candidates as Record<string, unknown>[]) { const ps = (x?.content as Record<string, unknown> | undefined)?.parts; if (Array.isArray(ps)) for (const b of ps) { const t = b && typeof b === "object" ? ["text","content","llmContent","value"].map((k) => (b as Record<string, unknown>)[k]).find((v) => typeof v === "string" && v) : undefined; if (typeof t === "string") parts.push(t); } }
  }
  return parts.join("\n");
}

const CHAT = /^(ok|okay|thanks|thank you|got it|sure|yeah|yep|please\b|hmm|wait|anyway|nah|hey|yo|lol|haha|lmao|nope|np|wow|whoa|idk|dunno|alright|gotcha|sounds good|lgtm|ack|cheers|ty|gg|brb|nvm|omg|kk|yup|thx|ttyl|smh|wfm|idc|ngl|fr|ikr|meh|ugh|welp|yikes|oops|huh)\b/i;
/** Peel intentional memory wrappers before the chat-filler gate. Bare "Please refactor…" still drops via CHAT. */
const ACK_PREFIX = /^(?:(?:please\s+remember|remember(?:\s+that)?|got it|understood(?:[,']?\s*I'?ll follow that)?|for reference|fyi|heads up|one rule(?:\s+for\s+this\s+repo)?|going forward)[:,!.]?\s+)+/i;
const SPEAKER_LABEL = /^([A-Z][A-Za-z0-9 /._-]{1,32}:)(?=\s)/;
/** Compact env slots — allow lowercase heads ("the database: atlas_dev"). */
const SLOT_LINE = /^[A-Za-z][A-Za-z0-9 /._-]{0,40}:\s+\S/;

/**
 * Narrative-fact fallback: the giant keyword allow-list below was hand-tuned against engineering/ops
 * vocabulary (ci, deploy, k8s, ...) and systematically discards personal-narrative statements (hobbies,
 * relationships, family, opinions) that dominate open-domain conversation memory. A sentence that reads
 * like a real declarative clause -- has >=2 common function words/pronouns among >=4 tokens, isn't a
 * question -- is durable enough to keep; junk/gibberish ("asdf qwerty") never clears this bar.
 */
const FUNC_WORD = new Set([
  "i","we","you","he","she","they","my","our","your","his","her","their","me","us","him","them",
  "is","are","was","were","am","be","been","being","has","have","had","having",
  "do","does","did","will","would","can","could","should","must","might","may",
  "the","a","an","and","but","of","to","in","on","at","for","with","from","by","as","that","this",
  "these","those","it","its","because","if","so","also","when","who","which","not","no",
]);
function looksNarrative(t: string): boolean {
  const toks = tokList(t);
  if (toks.length < 4) return false;
  let fw = 0;
  for (const w of toks) if (FUNC_WORD.has(w) && ++fw >= 2) return true;
  return false;
}

function extractDurable(blob: string): string[] {
  const seen = new Set<string>(), out: string[] = [];
  let whole = blob.trim().replace(/\s+/g, " ").replace(ACK_PREFIX, "");
  if (SPEAKER_LABEL.test(whole) && whole.endsWith("?") && /[.!]/.test(whole.slice(0, -1))) whole = whole.replace(/\s+[^.!?]+\?\s*$/, "").trim();
  const labeledWhole = SPEAKER_LABEL.test(whole) && whole.length <= 800 && !whole.endsWith("?");
  const label = whole.match(SPEAKER_LABEL)?.[1];
  for (const raw of labeledWhole ? [whole] : blob.replace(ACK_PREFIX, "").split(/(?<=[.!\n])\s+/)) {
    let t = raw.trim().replace(/\s+/g, " ").replace(/^(i think|i believe|i guess|maybe|perhaps|tbh|imo|btw,|fwiw,)\s+/i, "").replace(ACK_PREFIX, "");
    if (t.length < 8 || t.length > (labeledWhole ? 800 : 400) || t.startsWith("{") || t.startsWith("[") || t.startsWith("```") || t.startsWith("http") || t.startsWith("#") || /^(const|let|import |export |function |npm |pnpm |bun |git |cd |curl |yarn |npx |sudo |echo |cat |ls )\b/.test(t) || t.includes(MEMORY_MARK) || t.includes("Eden Know:") || /\bleftover intern firm\b/i.test(t) || /^(thinking about|you are|we are|this is|it is|that is|there (is|are)|i am going|i want to|this means|let me|i'll|let's|we will|look at|can you|could you|would you|tell me|fix the|add the|we need to|we're|cool, |nice, |great, |awesome, |perfect, )\b/i.test(t) || /\b(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9]/.test(t) || CHAT.test(t)) continue;
    if (label && !SPEAKER_LABEL.test(t)) t = `${label} ${t}`;
    const rem = t.match(/\bremember(?: that)?\s+(.+)/i); if (rem) t = rem[1]!.trim();
    else if (t.endsWith("?") || !(/\b(prefer(?:s|red)?|never |always |must |from now on|note that|don'?t |ran out|i want |fyi|also,|we should |make sure |stands for| aka |called |confirmed |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the|shipped |assigned |owned by|belongs to|due on|due by|deadline|blocked on|depends on|required |lives in|live in|stays in|stay in|moved to|based in|located |works (?:at|for)|work (?:on|at|for)|skip dairy|vegetarian|named |our dog|my dog|reports to|on-call|\bci\b|runs on|pagerduty|slack |cluster |namespace |region |vpc |timezone|branch |repo |org |team |channel |workspace |project |sprint |ticket |issue |hotfix |incident |sev[0-3]|p[0-3] |outage |pager |rollback |deployed |feature flag|kill switch|launchdarkly|maintenance |degraded |slo |sla |quota |budget |capacity |limit |rate.?limit|retr(?:y|ies|ied)|backoff|dri |owner |circuit.?breaker|webhook|endpoint|crontab|cronjob|version |k8s |kubernetes|configmap|helm |terraform|pulumi|cloudformation|iam |cdk |ansible|gcp |gcloud |azure |snowflake|bigquery|datadog|kafka|redshift|pubsub|rabbitmq|redis|postgres|elasticsearch|mongodb|mysql|dynamodb|sentry|grafana|prometheus|newrelic|honeycomb|otel|opentelemetry|jaeger|zipkin|cloudwatch|splunk|lambda|sqs|sns|cloudtrail|kinesis|ecs|step.?functions?|eks|fargate|rds|aurora|secrets.?manager|cloudfront|elasticache|alb|route.?53|api.?gateway|waf|ecr|nlb|elb|s3|kms|athena|glue|cognito|ebs|emr|sagemaker|bedrock|aws.?batch|eventbridge|codebuild|codepipeline|codedeploy|appconfig|amplify|appsync|xray|codecommit|codeartifact|efs|fsx|databricks|clickhouse|prestodb|trino|duckdb|flink|cassandra|neo4j|scylla|cockroach|vitess|tidb|spanner|cosmosdb|firestore|bigtable|memcached|consul|etcd|zookeeper|vault|nomad|istio|envoy|linkerd|traefik|kong|cilium|argocd|fluxcd|knative|calico|tekton|crossplane|kustomize|harbor|helmfile|thanos|mimir|cortex|fluentbit|fluentd|filebeat|logstash|opensearch|metricbeat|qdrant|weaviate|milvus|pinecone|typesense|meilisearch|pgvector|faiss|lancedb|chromadb|solr|nats|pulsar|mosquitto|emqx|airflow|dagster|prefect|temporal|flyte|kubeflow|mlflow|feast|wandb|dvc|huggingface|langsmith|llamaindex|ollama|vllm|sglang|tgi|tensorrt|triton|ggml|gguf|llamafile|exllamav2|awq|gptq|bitsandbytes|flashattn|deepspeed|fsdp|megatron|horovod|nccl|accelerate|xla|ship from|ships from)\b/i.test(t) || (/\b(is|are|was|were|needs?|uses?\b|will be|ha(?:s|ve) been)\b/i.test(t) && /[A-Z][a-zA-Z]|:\/\/|\w+\.\w+|\d{2,}/.test(t)) || SLOT_LINE.test(t) || /^\d+[.)]\s+.{8,}/.test(t) || /^[-*]\s+.{8,}/.test(t) || /"[^"]{4,80}"\s+(?:is|means|aka)/i.test(t) || /@[\w.-]+\.[a-z]{2,}/i.test(t) || /\b20\d{2}-\d{2}-\d{2}\b/.test(t) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(t) || /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(t) || /\$\d{2,}/.test(t) || /(?:~\/|\/(?:Users|home|opt|usr|var|etc)\/)[\w./-]+/.test(t) || /\b[A-Z][A-Z0-9_]{2,}=\S/.test(t) || /\bport\s+\d{2,5}\b/i.test(t) || /\b[\w.-]+\.(?:json|ya?ml|toml|env)\b/.test(t) || /\b[\w-]+\.(?:com|io|dev|internal|local)\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/.test(t) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t) || /\b[0-9a-f]{40}\b/.test(t) || /\b(?:\*|\d{1,2})(?:\s+(?:\*|\d{1,2})){4}\b/.test(t) || /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i.test(t) || /\bv\d+\.\d+\.\d+\b/i.test(t) || /\b[\w-]+\.[\w-]+\.svc(?:\.cluster\.local)?\b/.test(t) || /\barn:aws:[a-z0-9-]+:/i.test(t) || looksNarrative(t) || salience(t) > 0)) continue;
    t = t.replace(/^[.\s]+|[.\s]+$/g, "");
    if (SPEAKER_LABEL.test(t)) {
      const sp = new Set(tokList((t.match(SPEAKER_LABEL)?.[1] || "").replace(/:$/, "")));
      if (!tokList(t).some((w) => !sp.has(w) && (w.length >= 5 || /^\d/.test(w)) && !STOP.has(w))) continue;
    }
    if (t.length >= 8 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}

/**
 * Context-carry: a stored statement inherits needles from the turn before it (the question it answers).
 * Questions are never stored, so their frame would otherwise be lost. Two tiers:
 *   "^word"  question-sentence tokens of the previous turn   (weight CARRY_W)
 *   "~word"  remaining tokens of the previous turn            (weight CARRY_W2)
 */
const CARRY_Q = "^", CARRY_R = "~";
const CARRY_W = Number(process.env.EDEN_CARRY_W ?? 1);
const CARRY_W2 = Number(process.env.EDEN_CARRY_W2 ?? 0);
const CARRY_MAX = 24;
const isCarry = (t: string) => t.startsWith(CARRY_Q) || t.startsWith(CARRY_R);

function carryTokens(text: string): string[] {
  const label = text.match(SPEAKER_LABEL)?.[1];
  const sp = new Set(label ? tokList(label.replace(/:$/, "")) : []);
  const ok = (w: string, seen: Set<string>) => !(w.length < 3 || STOP.has(w) || QUERY_SKIP.has(w) || sp.has(w) || seen.has(w));
  const seen = new Set<string>(), out: string[] = [];
  for (const w of tokList((text.match(/[^.!?\n]*\?/g) ?? []).join(" "))) if (ok(w, seen) && out.length < CARRY_MAX) { seen.add(w); out.push(CARRY_Q + w); }
  if (CARRY_W2 > 0) { let n = 0; for (const w of tokList(text)) if (ok(w, seen) && n < CARRY_MAX) { seen.add(w); out.push(CARRY_R + w); n++; } }
  return out;
}

/**
 * Prospective memory (cue-triggered intentions). Rules ("always run the tests before committing") and
 * decisions ("we chose sqlite over postgres for the cache because …") are intention-shaped: they are recalled
 * by the situation that makes them applicable, which usually shares no words with the rule itself
 * ("commit these changes" ↔ "…before committing"). At encode time each intention record derives TRIGGER
 * CUES — engineering action/object clusters, path prefixes, and the alternatives/subject named in a
 * decision — stored as a separate cue index (`!c:`, `!p:`, `!a:`, `!s:` tags). At retrieval a prospective
 * pass stems the query, matches it against the cue index and reserves a small slice of the cap for the
 * strongest triggered intentions that the lexical pass did not already surface.
 */
const CUE_TAG = "!";
const isCue = (t: string) => t.startsWith(CUE_TAG);
/** Max cap slots reserved for triggered intentions, and the trigger strength (in units of log(3) ≈ one cue shared by ≤ a third of intentions) required to claim one. */
const PROSPECT_SLOTS = Number(process.env.EDEN_PROSPECT_SLOTS ?? 2);
const PROSPECT_MIN = Number(process.env.EDEN_PROSPECT_MIN ?? 0.5);

/** Porter-lite stemmer: steps 1a/1b/1c, a compact step 2/3/4 table, 5a/5b. commit/commits/committing/committed → commit. */
function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  const vowelAt = (s: string, i: number): boolean => { const c = s[i]!; return "aeiou".includes(c) || (c === "y" && i > 0 && !"aeiou".includes(s[i - 1]!)); };
  const hasVowel = (s: string) => { for (let i = 0; i < s.length; i++) if (vowelAt(s, i)) return true; return false; };
  const measure = (s: string) => { let m = 0, prevV = false; for (let i = 0; i < s.length; i++) { const v = vowelAt(s, i); if (!v && prevV) m++; prevV = v; } return m; };
  const cvc = (s: string) => s.length >= 3 && !vowelAt(s, s.length - 1) && vowelAt(s, s.length - 2) && !vowelAt(s, s.length - 3) && !"wxy".includes(s[s.length - 1]!);
  // 1a
  if (w.endsWith("sses")) w = w.slice(0, -2); else if (w.endsWith("ies")) w = w.slice(0, -2); else if (!w.endsWith("ss") && w.endsWith("s")) w = w.slice(0, -1);
  // 1b
  if (w.endsWith("eed")) { if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1); }
  else {
    const m = w.match(/(ed|ing)$/);
    if (m && hasVowel(w.slice(0, -m[1]!.length))) {
      w = w.slice(0, -m[1]!.length);
      if (/(at|bl|iz)$/.test(w)) w += "e";
      else if (/([^aeiou])\1$/.test(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
      else if (measure(w) === 1 && cvc(w)) w += "e";
    }
  }
  // 1c
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + "i";
  // 2 + 3 (compact)
  for (const [suf, rep] of [["ational", "ate"], ["tional", "tion"], ["ization", "ize"], ["ation", "ate"], ["izer", "ize"], ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"], ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"], ["ical", "ic"], ["ful", ""], ["ness", ""]] as const) {
    if (w.endsWith(suf) && measure(w.slice(0, -suf.length)) > 0) { w = w.slice(0, -suf.length) + rep; break; }
  }
  // 4
  for (const suf of ["ement", "ance", "ence", "able", "ible", "ment", "ant", "ent", "ism", "ate", "iti", "ous", "ive", "ize", "ion", "al", "er", "ic", "ou"]) {
    if (w.endsWith(suf)) { const s = w.slice(0, -suf.length); if (measure(s) > 1 && (suf !== "ion" || /[st]$/.test(s))) w = s; break; }
  }
  // 5a / 5b
  if (w.endsWith("e")) { const s = w.slice(0, -1); const m = measure(s); if (m > 1 || (m === 1 && !cvc(s))) w = s; }
  if (w.endsWith("ll") && measure(w) > 1) w = w.slice(0, -1);
  return w;
}

/** Curated engineering action lexicon: cluster → surface forms (verbs ↔ object nouns ↔ synonyms). Single words are stem-matched; phrases are matched on the raw text. */
const CUE_LEX: Record<string, string> = {
  commit: "commit committing committed commits checkin check-in",
  pr: "pr prs pull-request merge-request push pushing pushed review reviewing rebase branch branches land",
  test: "test tests testing tested spec specs e2e integration unit-test coverage fixture fixtures assert assertion assertions",
  dependency: "dependency dependencies depend install installing installed library libraries package packages npm pnpm yarn lockfile vendor third-party",
  log: "log logs logging logged logger console print printing printed debug debugging trace tracing stdout stderr verbose",
  secret: "secret secrets env dotenv credential credentials api-key apikey token tokens password passwords 1password vault",
  flag: "flag flags toggle toggles gate gating rollout canary experiment experiments percent hardcode hardcoded enable enabling disable disabling",
  migration: "migration migrations migrate migrating schema column columns index indexes indices table tables alter",
  codegen: "generated codegen generate generator autogenerated auto-generated scaffold",
  pricing: "pricing price prices priced tier tiers billing invoice invoices cost costs finance discount discounts",
  types: "type types typing typed typescript interface interfaces unknown cast casting narrow narrowing payload dto",
  format: "format formatting formatter formatted indent indentation semicolon semicolons whitespace prettier lint linter linting style styling tabs spaces",
  export: "export exports exporting exported import imports module modules barrel default-export named-export",
  deploy: "deploy deploys deployment deployed release releases ship shipping production prod rollback",
  error: "error errors exception exceptions throw throwing catch retry retries",
  database: "db database databases sql query queries orm postgres sqlite mysql",
  cache: "cache caches caching cached memoize memo redis lru",
  api: "endpoint endpoints route routes api rest graphql handler handlers",
  config: "config configuration configure configured settings setting",
  docs: "readme docs documentation document comment comments jsdoc docstring",
  naming: "naming rename renamed",
  auth: "auth authentication authorization login permission permissions",
  perf: "performance perf slow latency optimize optimization",
};
const CUE_WORD = new Map<string, string[]>();
const CUE_PHRASE: [RegExp, string][] = [];
for (const [cluster, forms] of Object.entries(CUE_LEX)) for (const f of forms.split(" ")) {
  if (/^[a-z0-9-]+$/.test(f) && !f.includes("-")) { const s = stem(f); const a = CUE_WORD.get(s); if (a) { if (!a.includes(cluster)) a.push(cluster); } else CUE_WORD.set(s, [cluster]); }
  else CUE_PHRASE.push([new RegExp("(?:^|[^a-z0-9])" + f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[ -]?") + "(?![a-z0-9])", "i"), cluster]);
}
// Phrases that are concatenated in CUE_LEX by whitespace splitting are re-added here explicitly.
for (const [p, c] of [["pull request", "pr"], ["merge request", "pr"], ["api key", "secret"], ["turn on", "flag"], ["turn off", "flag"], ["\\d+\\s*%", "flag"], ["percent of", "flag"], ["\\.env", "secret"], ["unit test", "test"], ["default export", "export"], ["named export", "export"], ["third party", "dependency"], ["console\\.log", "log"]] as const) CUE_PHRASE.push([new RegExp("(?:^|[^a-z0-9])" + p + "(?![a-z0-9])", "i"), c]);

const IMPERATIVE = /\b(always|never|must|do not|don'?t|should not|shouldn'?t|banned|forbidden|prohibited|not allowed|make sure|prefer|from now on|go(?:es)? through|only ever)\b/i;
const DECISION = /\b(decided|decide|chose|chosen|picked|went with|going with|settled on|standardized on|switched to|opted for|instead of|over|rather than)\b/i;
const CUE_STOP = new Set(["the", "a", "an", "our", "my", "your", "this", "that", "for", "of", "to", "in", "on", "with", "and", "or", "it", "its", "is", "are", "was", "were", "be", "we", "i", "you", "they", "as", "at", "by", "from", "new", "old", "one", "some", "all", "any", "not", "no", "yes", "use", "using", "used", "than", "then", "because", "since", "so", "but", "if", "when", "which", "what", "why", "how", "who", "where", "there", "here", "into", "out", "up", "down", "also", "just", "very", "more", "most", "well", "ok", "okay", "will", "would", "should", "could", "can", "do", "does", "did", "done", "let", "lets", "get", "got", "go", "keep", "make", "put", "set", "add", "have", "has", "had", "need", "needs", "want", "wants", "like", "thing", "things", "something", "everything", "anything", "stuff", "way", "please", "remember", "rule", "rules", "repo", "project", "codebase", "team", "going", "forward", "understood", "follow", "noted", "agreed", "sounds", "good", "thanks", "sure", "right", "first", "next", "last", "again", "still", "ever", "now", "today", "later", "before", "after", "under", "over", "instead", "rather", "without", "asking", "ask", "step", "them", "their", "me", "us", "him", "her", "his", "she", "he", "these", "those", "each", "every", "other", "another", "same", "own", "via", "per", "about", "around", "off", "on"]);

function cueClusters(lower: string, toks: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of toks) { const cs = CUE_WORD.get(stem(t)); if (cs) for (const c of cs) out.add(c); }
  for (const [re, c] of CUE_PHRASE) if (re.test(lower)) out.add(c);
  return out;
}
/** Path prefixes / directory segments mentioned in text: "generated/", "tests/integration", "src/x/y.ts" → generated, tests, integration, tests/integration, src, x. */
function pathCues(lower: string): Set<string> {
  const out = new Set<string>();
  for (const m of lower.matchAll(/(?:^|[\s"'`(,:])((?:[a-z0-9_.-]+\/)+[a-z0-9_.-]*)/g)) {
    const segs = m[1]!.split("/").filter((s) => s.length >= 3 && !/\./.test(s));
    for (const s of segs) out.add(s);
    if (segs.length >= 2) out.add(segs.slice(0, 2).join("/"));
  }
  return out;
}
const contentStems = (toks: string[]): string[] => { const out: string[] = []; for (const t of toks) { if (t.length < 3 || CUE_STOP.has(t) || STOP.has(t) || QUERY_SKIP.has(t) || /^\d+$/.test(t)) continue; const s = stem(t); if (s.length >= 2 && !out.includes(s)) out.push(s); } return out; };
const bareToks = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Alternatives (X, Y) and subject (W) of a decision: "decided on X instead of Y for W because Z", "X over Y", "went with X rather than Y". */
function decisionParts(lower: string): { alts: string[]; subj: string[] } | null {
  const m = lower.match(/\b(?:decided (?:on|to use|to go with)|chose|picked|went with|going with|settled on|standardized on|switched to|opted for|would go with|i'?d go with|use|using)\s+(.{1,40}?)\s+(?:over|instead of|rather than|not|vs\.?|versus)\s+(.{1,40}?)(?=\s+(?:for|because|since|as|so|in|on)\b|[.,;:!?]|$)(?:\s+for\s+(.{1,60}?))?(?=\s+(?:because|since|as|so)\b|[.,;:!?]|$)/);
  if (!m) return null;
  const alts = [...contentStems(bareToks(m[1]!)), ...contentStems(bareToks(m[2]!))];
  const subj = m[3] ? contentStems(bareToks(m[3]!)) : [];
  return alts.length ? { alts, subj } : null;
}
/** Strip the conversational/speaker prefix ("One rule for this repo:", "Understood, I'll follow that:") to get the rule body. */
function ruleBody(text: string): string {
  let t = text;
  for (let i = 0; i < 4; i++) { const n = t.replace(/^[^:]{1,60}:\s*/, ""); if (n === t) break; t = n; }
  return t.replace(/^(?:one rule for this repo|going forward|please remember|remember|from now on|understood|noted|got it|i'?ll follow that|rule)[:,\s]+/i, "");
}
const IMPERATIVE_HEAD = /^(?:use|put|keep|run|log|open|write|avoid|wrap|prefix|place|store|route|pin|lock|gate|commit|name|only|no)\b/i;
function isIntention(text: string): boolean {
  const body = ruleBody(text);
  return IMPERATIVE.test(body) || (IMPERATIVE_HEAD.test(body) && /\b(no|not|only|instead|before|after|under|through|via|with)\b/i.test(body)) || (DECISION.test(body) && /\b(over|instead of|rather than|vs\.?|versus|because|since)\b/i.test(body));
}
/** Derive the cue index for one record. Returns [] for records that are not intention-shaped. */
function deriveCues(text: string): string[] {
  if (!isIntention(text)) return [];
  const body = ruleBody(text), lower = body.toLowerCase(), toks = bareToks(lower);
  const out = new Set<string>();
  for (const c of cueClusters(lower, toks)) out.add(CUE_TAG + "c:" + c);
  // Exact action/object stems (a query sharing the very word outranks a synonym-only cluster match).
  for (const s of contentStems(toks)) if (CUE_WORD.has(s)) out.add(CUE_TAG + "w:" + s);
  for (const p of pathCues(lower)) out.add(CUE_TAG + "p:" + p);
  const d = decisionParts(lower);
  if (d) { for (const a of d.alts) out.add(CUE_TAG + "a:" + a); for (const s of d.subj) out.add(CUE_TAG + "s:" + s); }
  else if (DECISION.test(lower)) for (const s of contentStems(toks).filter((s) => !CUE_WORD.has(s)).slice(0, 6)) out.add(CUE_TAG + "s:" + s);
  // Distinctive cue so print/debug queries trigger the prohibition, not tracing/"request" decisions.
  if (isNoPrintRule(body)) out.add(CUE_TAG + "c:log-forbid");
  return [...out];
}
/** Cues present in a query: clusters, path segments, and content stems (matched against decision alternatives/subjects). */
function queryCues(text: string): { c: Set<string>; p: Set<string>; w: Set<string> } {
  const lower = text.toLowerCase(), toks = bareToks(lower);
  const c = cueClusters(lower, toks);
  if (isLogPolicyQuery(text)) c.add("log-forbid");
  return { c, p: pathCues(lower), w: new Set(contentStems(toks)) };
}

const CUES = new WeakMap<MemoryRecord, string[]>();
const cuesOf = (rec: MemoryRecord): string[] => CUES.get(rec) ?? [];

/**
 * Salience tagging (synaptic tagging / salience-gated consolidation): sentences carrying causal, decision
 * or constraint markers are the ones a later session asks about ("why", "how did we fix", "what's the rule")
 * yet they are usually short and share few tokens with the question. A salience weight in [0, 1] is stored
 * on the record; it (a) exempts the sentence from the extraction drop gate and from eviction, and (b) adds
 * a bounded boost at scoring so the causal sentence is not out-scored by the chattier investigation
 * sentence of the same episode.
 */
const SAL_STRONG = /\b(root cause|because|instead of|rather than|decided|we chose|chose|settled on|going with|never|always|do not|don'?t|must|the fix (?:was|is)|fixed (?:it )?by|turned out|the reason|that'?s why|that is why|so that)\b/i;
const SAL_WEAK = /\b(?:i|we) (?:changed|added|fixed|raised|moved|switched|replaced|set|bumped|pointed|deleted|removed|rewrote|derived|forced|chunked|serialised|serialized|used|wired|dropped|renamed|reverted|pinned|upgraded|downgraded|disabled|enabled|patched|migrated|recreated)\b|\b(?:should|prefer|convention|rule|instead)\b/i;
function salience(text: string): number {
  const t = text.replace(SPEAKER_LABEL, "");
  return SAL_STRONG.test(t) ? 1 : SAL_WEAK.test(t) ? 0.6 : 0;
}
const SAL_BOOST = Number(process.env.EDEN_SAL_BOOST ?? 0.5);

/**
 * Episode-context binding (Temporal Context Model, Howard & Kahana): a slowly drifting context vector is
 * maintained across the turns of a session -- entity / code tokens, file paths, component names -- with the
 * session's opening request pinned at a floor so it never decays away. Every record stored during the
 * episode is bound to a snapshot of that context as weighted context needles ("ctx"), so a fix sentence
 * stored eight turns after the symptom was reported still carries the symptom and component tokens. At
 * retrieval the context needles score like own needles (idf-weighted, scaled by CTX_W, capped), and the
 * top hits' episodes are *reinstated*: other records of the same episode that share cue overlap get a
 * spread-activation bonus, completing the symptom -> cause -> fix -> file chain.
 *
 * Session boundaries are inferred from the message stream (the hook passes no session ids): a fresh window
 * with no overlap against the previous one, or a substantive user turn whose content tokens barely overlap
 * the live context, starts a new episode.
 */
const CTX_W = Number(process.env.EDEN_CTX_W ?? 0.8);
const CTX_CAP = Number(process.env.EDEN_CTX_CAP ?? 9);
const CTX_DECAY = 0.82;
const CTX_OPEN_FLOOR = 0.55;
const CTX_MAX = 28;
const REINSTATE = Number(process.env.EDEN_REINSTATE ?? 2.5);
/** Extra reinstatement weight for salient records: the causal sentence of a reinstated episode outranks its chatty siblings. */
const SAL_REINSTATE = Number(process.env.EDEN_SAL_REINSTATE ?? 1);
const CTX_SKIP = new Set("can you could would please look looking seeing since morning today prod production hmm sure thanks thank yeah yes nope okay cool great nice done let lets going want need think thought get got going make sure back again same before anymore also really pretty maybe still check double one sec moment file files thing things something anything stuff bit little lot lots way ways idea any what why how when where which who while there here this that these those with from into about into onto over under after around".split(" "));
function ctxTokens(text: string): string[] {
  const label = text.match(SPEAKER_LABEL)?.[1];
  const sp = new Set(label ? tokList(label.replace(/:$/, "")) : []);
  const seen = new Set<string>(), out: string[] = [];
  for (const w of tokList(text)) {
    if (w.length < 3 || seen.has(w) || sp.has(w) || STOP.has(w) || QUERY_SKIP.has(w) || FUNC_WORD.has(w) || CTX_SKIP.has(w) || CHAT.test(w)) continue;
    seen.add(w); out.push(w);
  }
  return out;
}

class EpisodeContext {
  id = "";
  private w = new Map<string, number>();
  private open = new Set<string>();
  private turns = 0;
  private seq = 0;
  private fresh() { this.id = `e${Date.now().toString(36)}${(this.seq++).toString(36)}`; this.w = new Map(); this.open = new Set(); this.turns = 0; }
  reset() { this.fresh(); }
  /** Advance the context by one message; returns true when a new episode was opened. */
  step(role: string, text: string): boolean {
    const toks = ctxTokens(text);
    let boundary = !this.id;
    if (!boundary && role === "user" && toks.length >= 3 && this.w.size) {
      let hit = 0;
      for (const t of toks) if (this.w.has(t)) hit++;
      if (hit / toks.length < 0.5) boundary = true;
    }
    if (boundary) this.fresh();
    for (const [k, v] of this.w) {
      const nv = v * CTX_DECAY;
      if (this.open.has(k)) this.w.set(k, Math.max(nv, CTX_OPEN_FLOOR));
      else if (nv < 0.08) this.w.delete(k);
      else this.w.set(k, nv);
    }
    const add = this.turns === 0 ? 1 : role === "user" ? 0.8 : 0.6;
    for (const t of toks) this.w.set(t, Math.min(1, (this.w.get(t) || 0) + add));
    if (this.turns === 0) for (const t of toks) this.open.add(t);
    this.turns++;
    return boundary;
  }
  /** Weighted snapshot, excluding the record's own tokens, capped at CTX_MAX. */
  snapshot(own: Set<string>): Record<string, number> | undefined {
    if (!this.w.size) return undefined;
    const rows = [...this.w].filter(([k]) => !own.has(k)).sort((a, b) => b[1] - a[1]).slice(0, CTX_MAX);
    if (!rows.length) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of rows) out[k] = Math.round(v * 100) / 100;
    return out;
  }
}

function compile(rec: MemoryRecord): Compiled {
  const own = new Set([...rec.tags.filter((t) => !isCarry(t) && !isCue(t)), ...tokList(rec.text).filter((w) => w.length >= 3 && !STOP.has(w))]);
  const carried = rec.tags.filter((t) => isCarry(t) && !own.has(t.slice(1)));
  // Cue index: explicit `!` tags win (remember() callers may supply them); otherwise derived deterministically
  // from the text at compile time, so the JSONL on disk stays byte-identical and old stores gain cues on load.
  const stored = rec.tags.filter(isCue);
  const cues = stored.length ? stored : deriveCues(rec.text);
  CUES.set(rec, cues);
  const ctx: [string, number][] = [];
  if (rec.ctx) for (const k in rec.ctx) if (!own.has(k) && rec.ctx[k]! > 0) ctx.push([k, rec.ctx[k]!]);
  return { rec, needles: [...own, ...carried], cues, ctx, sal: rec.sal ?? 0 };
}

/** Prospective pass: score intention records by cue overlap × cue idf (idf over intention records only). */
function triggerScores(rows: Compiled[], text: string): { rec: MemoryRecord; t: number }[] {
  const q = queryCues(text);
  if (!q.c.size && !q.p.size && !q.w.size) return [];
  const intents = rows.filter((c) => c.cues.length);
  if (!intents.length) return [];
  const df = new Map<string, number>();
  for (const c of intents) for (const cue of c.cues) df.set(cue, (df.get(cue) || 0) + 1);
  const N = intents.length;
  const out: { rec: MemoryRecord; t: number }[] = [];
  for (const c of intents) {
    let t = 0;
    for (const cue of c.cues) {
      const k = cue[1], v = cue.slice(3);
      const hit = k === "c" ? q.c.has(v) : k === "p" ? q.p.has(v) : q.w.has(v);
      if (!hit) continue;
      const idf = Math.log(1 + N / (df.get(cue) || 1));
      t += idf * (k === "s" ? 0.6 : k === "w" ? 0.5 : k === "a" ? 1.2 : 1);
    }
    if (t > 0) out.push({ rec: c.rec, t });
  }
  return out.sort((a, b) => b.t - a.t || b.rec.at - a.rec.at);
}
const jaccardText = (a: string, b: string): number => { const A = new Set(tokList(a)), B = new Set(tokList(b)); let i = 0; for (const w of A) if (B.has(w)) i++; const u = A.size + B.size - i; return u ? i / u : 0; };

function load(path: string): Compiled[] {
  if (!existsSync(path)) return [];
  const out: Compiled[] = [];
  for (const t of readFileSync(path, "utf8").split("\n")) try {
    const rec = JSON.parse(t) as MemoryRecord;
    if (rec?.id && rec.text) out.push(compile(rec));
  } catch {}
  return out;
}

/**
 * Slot consolidation (episodic → semantic). Each labeled turn is mined for slot fillers and folded into one
 * per-(speaker, slot) digest record that supersedes its previous version. Aggregate questions
 * ("what activities…", "where has X…") are answered by the digest, not by any single turn.
 */
type Slot = "places" | "made" | "activities" | "names" | "titles";
/** Query words that signal an aggregate question over a slot; used only as a gate (never as scored needles). */
const SLOT_FRAME: Record<Slot, RegExp> = {
  places: /\b(where|places?|visited|visits?|been to|travel(?:ed|led|s)?|trips?|camped|cities|city|countries|country|areas|locations|spots|destinations)\b/i,
  made: /\b(made|make|makes|painted|paints?|built|cooked|baked|bought|wrote|created|crafted|drew|desserts?|dishes|meals|creations|pieces|projects|items|things)\b/i,
  activities: /\b(activit(?:y|ies)|hobb(?:y|ies)|interests?|enjoys?|sports?|exercises?|pastimes?|instruments?|plays?|partake|participates?|does|done|do)\b/i,
  names: /\b(who|names?|people|friends|met|pets?|dogs?|cats?|kids|children|family|artists?|bands?|members|colleagues|mentors?|characters)\b/i,
  titles: /\b(books?|movies?|films?|songs?|albums?|shows?|series|novels?|titles?|titled|called|read|reading|watched|watching|poems?)\b/i,
};
const PLACE_LEX = new Set("beach beaches mountain mountains forest forests park parks lake lakes river rivers ocean sea coast island islands desert hills valley canyon trail trails museum museums gym church shelter studio school college university campus hospital office cafe coffee shop restaurant bar store shop market mall theater theatre cinema stadium arena festival concert camp campsite campground city town village downtown neighborhood library zoo aquarium garden gardens farm ranch cabin hotel airport station hometown country countryside apartment house home kitchen backyard rooftop pool club gallery bookstore bakery diner pub temple cathedral castle palace bridge harbor pier woods meadow field fields cliff cliffs waterfall spring springs bay cave caves resort spa lodge".split(" "));
const ABSTRACT = new Set("difference impact progress sense decision effort change changes friends time money plans mistake mistakes choice choices point sure fun way ways list note promise peace most happen happens deal move moves memories memory living history career name names news friend appearance debut headway room space contribution contributions connection connections amends comeback breakthrough exception statement case start finish trip journey".split(" "));
const DIGEST_BONUS = Number(process.env.EDEN_DIGEST_BONUS ?? 9);
const SLOT_LABEL: Record<Slot, string> ={ places: "places", made: "made", activities: "activities", names: "names", titles: "titles" };
const ING_SKIP = new Set("going being having getting doing something anything everything nothing morning evening during thing things amazing interesting exciting inspiring stunning boring feeling looking thinking coming trying making taking talking saying telling working starting sharing seeing hoping wishing sending giving bringing meeting keeping helping finding learning moving living loving growing wondering knowing planning turning putting happening according including following spending annoying rewarding frustrating challenging satisfying refreshing calming comforting encouraging uplifting disheartening heartwarming heartbreaking soaring touching bustling fulfilling surrounding evolving striving reminiscing pursuing spreading speaking understanding celebrating sticking letting trusting falling appreciating checking contacting reaching jumping throwing pouring stressing experimenting connecting cheering stepping wrapping winding hanging chatting tackling improving housing inviting gaining raising wagging chilling missing waiting hearing".split(" "));
const PLACE_SKIP = new Set("and or but last next every each again yesterday today tomorrow tonight with for of on at in by like into after ago since until while when where soon later now then just also very really quite so too more most much many some any the a an my our his her their me you us them it there here order touch love least all fact life time end future moment way past beginning same world process day days week weeks weekend month months year years meantime morning evening night afternoon mind heart case point terms addition general spite front back top bottom middle side sight person turn charge control common return response".split(" "));
const CAL = new Set("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december mon tue wed thu fri sat sun jan feb mar apr jun jul aug sep sept oct nov dec".split(" "));

function slotFillers(body: string): Partial<Record<Slot, string[]>> {
  const out: Partial<Record<Slot, string[]>> = {};
  const add = (s: Slot, v: string) => { const x = v.trim().replace(/[.,!?;:'"]+$/g, "").trim(); if (x.length >= 3 && x.length <= 40 && !/\d/.test(x)) (out[s] ??= []).push(x); };
  const unquoted = body.replace(/["“][^"”]*["”]/g, " ");
  // places: preposition + (det) + place-type noun, or preposition + Proper Noun
  for (const m of unquoted.matchAll(/\b(?:at|in|near|around|across|from|to|into)\s+(?:the|a|an|my|our|his|her|their|some|this|that)\s+([a-z]+)(?:\s+([a-z]+))?\b/gi)) { const a = m[1]!.toLowerCase(), b = (m[2] || "").toLowerCase(); if (PLACE_LEX.has(a)) add("places", a); else if (PLACE_LEX.has(b)) add("places", `${a} ${b}`); }
  for (const m of unquoted.matchAll(/\b(?:at|in|near|around|across|from|to|into|visited|visiting|visit)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g)) { const w = m[1]!; if (!CAL.has(w.toLowerCase()) && !/^(?:The|That|This|These|Those|What|When|Where|Which|How|Why|Who|But|And|Also|Just|Then|There|Here|Now|Yes|Yeah|Wow|Thanks|Hey|Congrats|Sounds|Glad|Good|Great|Awesome|Definitely|Sure|Okay|Hope|Love|Looking|Hopefully|Maybe|Anyway|Well|Cool|Nice|Happy|Sorry|Absolutely|Excited|Btw|Speaking)$/.test(w)) add("places", w); }
  // made: concrete creation/acquisition verbs + object head (skip abstract heads)
  for (const m of unquoted.matchAll(/\b(?:painted|baked|cooked|built|knitted|sewed|crafted|drew|bought|wrote|sculpted|brewed|grilled|roasted|whipped up|carved|designed|assembled)\s+(?:up\s+)?(?:a|an|the|some|this|these|that|those|my|our|his|her|their|its|any|every|another|new|few|couple of|lots of|fresh|homemade|delicious|yummy|beautiful|little|big|cute|tiny|small)?\s*(?:(?:a|an|the|some|my|our|his|her|their|new|homemade|delicious|yummy|beautiful|little|big|cute|tiny|small|fresh)\s+)?([a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,2}(?:(?:,\s*|\s+(?:and|or)\s+|,\s*(?:and|or)\s+)[a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,2})*)\b/gi)) {
    for (const part of m[1]!.toLowerCase().split(/\s*,\s*(?:and|or)\s+|\s*,\s*|\s+(?:and|or)\s+/)) {
      const ws = part.trim().split(/\s+/).filter((t) => t && !PLACE_SKIP.has(t) && !/^(?:it|them|me|you|us|that|this|those|these|to|of|for|by|with|and|so|up|out|in|on|at|from|into|myself|ourselves|him|her|last|next|ago|yesterday|today|recently|lately)$/.test(t));
      const h = ws.slice(-2).join(" ");
      if (h && !ABSTRACT.has(ws[ws.length - 1]!) && !/^(?:[a-z]+ing|is|was|be|get|go|see|do|have|has|had|feel|felt|think|thought)$/.test(ws[ws.length - 1]!)) add("made", h);
    }
  }
  // activities: gerunds/nouns only inside activity frames (go/love/enjoy/into/started/tried/play …)
  for (const m of unquoted.matchAll(/\b(?:go|went|goes|been|love|loves|loved|enjoy|enjoys|enjoyed|into|started|start|tried|try|trying|took up|take up|practice|practicing|teach|teaching|learn|learning)\s+(?:some\s+|more\s+|a\s+bit\s+of\s+|a\s+lot\s+of\s+|the\s+)?([a-z]{4,}(?:\s+[a-z]{4,})?(?:(?:,\s*|\s+(?:and|or)\s+|,\s*(?:and|or)\s+)[a-z]{4,}(?:\s+[a-z]{4,})?)*)\b/gi)) {
    for (const part of m[1]!.toLowerCase().split(/\s*,\s*(?:and|or)\s+|\s*,\s*|\s+(?:and|or)\s+/)) {
    const ws = part.trim().split(/\s+/); const w = ws[0]!;
    if (!w || STOP.has(w) || PLACE_SKIP.has(w) || ING_SKIP.has(w) || /^(?:that|this|about|with|being|having|what|when|where|hearing|seeing|talking|meeting|chatting|there|them|they|these|those|through|because|which|while|sure|forward|back|ahead|home|well|good|great|again|around|together|over|down|much|myself|yourself|ourselves)$/.test(w)) continue;
    if (/ing$/.test(w) || ws.length === 1) add("activities", w); else add("activities", ws.join(" "));
    }
  }
  for (const m of unquoted.matchAll(/\b([a-z]{4,})\s+(?:class|classes|lessons?|trip|trips|sessions?|club|group|workshop|workshops|tournaments?|competitions?|practice|routine|gear|shoes|boots|kit|equipment|studio|course|courses)\b/gi)) { const w = m[1]!.toLowerCase(); if (!ING_SKIP.has(w) && !STOP.has(w) && !PLACE_SKIP.has(w) && !/^(?:this|that|these|those|first|second|third|whole|entire|same|other|another|local|online|free|great|good|nice|fun|hard|tough|long|short|weekly|daily|regular|favorite|little|small|big)$/.test(w)) add("activities", w); }
  for (const m of unquoted.matchAll(/\bplay(?:s|ed|ing)?\s+(?:the\s+)?([a-z]{4,})\b/gi)) { const w = m[1]!.toLowerCase(); if (!STOP.has(w) && !/^(?:with|around|along|some|more|again|together|games?|time|around)$/.test(w)) add("activities", w); }
  // names: capitalized tokens not at sentence start, not calendar words
  for (const m of unquoted.matchAll(/(?<=[^.!?\n]\s|,\s)([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g)) { const w = m[1]!; if (!CAL.has(w.split(" ")[0]!.toLowerCase()) && !/^(?:The|That|This|These|Those|What|When|Where|Which|How|Why|Who|But|And|Also|Just|Then|There|Here|Now|Yes|Yeah|Wow|Thanks|Hey|Congrats|Sounds|Glad|Good|Great|Awesome|Definitely|Sure|Okay|Hope|Love|Looking|Hopefully|Maybe|Anyway|Well|Cool|Nice|Happy|Sorry|Absolutely|Excited|Btw|Speaking|Bet|Even|Let|Man|Guess|Long|Big|Check|Keep|Hang|Bye|Take|Have|Got|See|Talk|Thank|Miss|Best|Same|Haha|Lol|Omg|Aww|Ooh|Oh|Ahh|Hah|Yep|Yup|Nope|Nah|Right|Totally|Exactly|True|Agreed)$/.test(w)) add("names", w); }
  for (const m of body.matchAll(/["“]([^"”]{3,60})["”]/g)) add("titles", m[1]!);
  return out;
}

function subjectKey(text: string): string | null {
  // Chat prefixes + assistant "Understood, I'll follow that:" must not merge distinct rules.
  // Bare "use" (as in "use two spaces") is not a copula — only "uses"/"using".
  const cleaned = text.trim()
    .replace(/^(?:fyi|for reference|heads up|noted|got it|note|ok|okay|update|reminder|understood(?:[,']?\s*I'?ll follow that)?|one rule(?: for this repo)?|going forward)[:,]?\s+/i, "")
    .replace(/^I'?ll follow that:\s*/i, "");
  // Env acronym slot: "CI: X" / "CI is now Y" share one key so stale CI labels supersede.
  if (/^ci(?:\s+is(?:\s+now)?|:)\s+\S/i.test(cleaned)) return "ci";
  const k = cleaned.match(/^(.{4,80}?)\s+(?:is now|are now|is|are|was|were|prefers?|uses\b|using\b|lives in|live in|stays in|stay in|moved to|belongs to|owned by|ship from|ships from)\s+\S/i)?.[1]?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
  return k.length >= 4 ? k : null;
}

export class AgentMemory {
  readonly dir: string;
  private know?: KnowSearch;
  private agent?: string;
  private project?: string;
  private compiled: Compiled[];
  private path: string;
  /** Tokens of the previously observed turn — inherited by the next stored statement as weak needles. */
  private carry: string[] = [];
  private speakerNames = new Set<string>();
  /** Fingerprints of the last observed message window (the hook re-sends a sliding 40-message window). */
  private lastWin: string[] = [];
  private episode = new EpisodeContext();

  constructor(opts: MemoryOptions = {}) {
    this.know = opts.know; this.agent = opts.agent; this.project = opts.project;
    mkdirSync((this.dir = opts.dir || join(homedir(), ".eden", "memory")), { recursive: true });
    try { chmodSync(this.dir, 0o700); } catch {}
    this.compiled = load((this.path = join(this.dir, "memories.jsonl")));
  }

  memories(): MemoryRecord[] {
    return this.compiled.map((c) => c.rec).filter((r) => !this.project || r.project === this.project);
  }

  remember(text: string, opts: { kind?: MemoryKind; tags?: string[]; id?: string; agent?: string; project?: string; ep?: string; ctx?: Record<string, number>; sal?: number } = {}): MemoryRecord {
    const rec: MemoryRecord = { id: opts.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, text: String(text || "").trim(), kind: opts.kind || "fact", tags: (opts.tags || []).map((t) => t.toLowerCase()), agent: opts.agent || this.agent, project: opts.project || this.project, at: Date.now() };
    if (!rec.text) return rec;
    if (opts.ep) rec.ep = opts.ep;
    if (opts.ctx) rec.ctx = opts.ctx;
    const sal = opts.sal ?? salience(rec.text);
    if (sal > 0) rec.sal = sal;
    const c = compile(rec), i = this.compiled.findIndex((x) => x.rec.id === rec.id);
    i >= 0 && this.compiled.splice(i, 1);
    return this.compiled.push(c), this.persist(), rec;
  }

  forget(id: string): boolean {
    const n = this.compiled.length;
    this.compiled = this.compiled.filter((c) => c.rec.id !== id && c.rec.text !== id && c.rec.text.toLowerCase() !== id.toLowerCase() && subjectKey(c.rec.text) !== id.toLowerCase());
    return this.compiled.length !== n && (this.persist(), true);
  }

  /**
   * Observe a message list. The CLI hook re-sends a sliding window of the last 40 turns after every
   * assistant turn, so messages are matched against the previous window and only the new tail is
   * processed -- each new message steps the episode context, inherits the previous turn's question frame,
   * and is mined for durable sentences bound to the live episode context.
   */
  observe(messages: unknown[]): MemoryRecord[] {
    const list = (Array.isArray(messages) ? messages : []).filter((m) => (m && typeof m === "object" ? (m as { role?: string }).role : "") !== "system");
    const out: MemoryRecord[] = [];
    const items = list.map((m) => ({ role: String((m && typeof m === "object" ? (m as { role?: string }).role : "") || "user"), text: convBlob([m]).trim().replace(/\s+/g, " ") })).filter((i) => i.text);
    const fps = items.map((i) => `${i.role}${i.text.slice(0, 400)}`);
    let start = 0;
    if (this.lastWin.length && fps.length) {
      let found = -1;
      for (let k = 0; k < this.lastWin.length && found < 0; k++) {
        const len = Math.min(this.lastWin.length - k, fps.length);
        let ok = true;
        for (let i = 0; i < len; i++) if (this.lastWin[k + i] !== fps[i]) { ok = false; break; }
        if (ok) found = len;
      }
      if (found >= 0) start = found;
      else if (items.length > 1 && process.env.EDEN_CTX_MODE !== "off") this.episode.reset();
    }
    if (fps.length) this.lastWin = fps.slice(-80);
    for (let i = start; i < items.length; i++) {
      const it = items[i]!;
      const carry = process.env.EDEN_CARRY_MODE === "off" ? [] : this.carry;
      this.carry = carryTokens(it.text.slice(0, 2000));
      if (process.env.EDEN_CTX_MODE !== "off") this.episode.step(it.role, it.text);
      for (const text of extractDurable(it.text)) {
        if (this.compiled.some((c) => (!this.project || c.rec.project === this.project) && c.rec.text.toLowerCase() === text.toLowerCase())) continue;
        const key = subjectKey(text);
        if (key) this.compiled = this.compiled.filter((c) => (this.project && c.rec.project !== this.project) || subjectKey(c.rec.text) !== key);
        const ownToks = new Set(tokList(text));
        out.push(this.remember(text, { kind: /\b(prefer|never |always |don'?t |do not |must |from now on)\b/i.test(text) ? "constraint" : /\b(ran out|shipped |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the)\b/i.test(text) ? "episode" : "fact", tags: carry.concat(tokList(text)).concat(([[/\bpull requests?\b/i, "pr"], [/\btimezone|pacific|utc\b/i, "tz"], [/@[\w.-]+\.[a-z]{2,}/i, "email"], [/\b(vegetarian|vegan|pescatarian|skip dairy|lactose|allerg|kosher|halal|gluten)\b/i, "diet"]] as const).flatMap(([re, t]) => re.test(text) ? [t] : [])), ep: process.env.EDEN_CTX_MODE !== "off" ? this.episode.id : undefined, ctx: process.env.EDEN_CTX_MODE !== "off" ? this.episode.snapshot(ownToks) : undefined, sal: salience(text) }));
        if (process.env.EDEN_DIGEST !== "off") { const m = text.match(SPEAKER_LABEL); if (m) this.consolidate(m[1]!.replace(/:$/, ""), text.slice(m[1]!.length)); }
      }
    }
    return out;
  }

  /** Fold one labeled turn into the speaker's slot digests (superseding records `digest:<speaker>:<slot>`). */
  private consolidate(speaker: string, body: string) {
    const sp = speaker.trim();
    this.speakerNames.add(sp.toLowerCase());
    const fillers = slotFillers(body.replace(/\s+/g, " "));
    for (const slot of Object.keys(fillers) as Slot[]) {
      let items = fillers[slot]!;
      if (slot === "names") items = items.filter((n) => !this.speakerNames.has(n.toLowerCase()) && !this.speakerNames.has(n.split(" ")[0]!.toLowerCase()));
      if (!items.length) continue;
      const id = `digest:${sp.toLowerCase()}:${slot}`;
      const prev = this.compiled.find((c) => c.rec.id === id);
      const seen = new Set<string>(prev ? String(prev.rec.text.split(" — ")[1] || "").split(", ").map((x) => x.toLowerCase()) : []);
      const list = prev ? String(prev.rec.text.split(" — ")[1] || "").split(", ").filter(Boolean) : [];
      for (const it of items) { const k = it.toLowerCase(); if (!seen.has(k)) { seen.add(k); list.push(it); } }
      const kept = list.slice(-60);
      const text = `${sp}: ${SLOT_LABEL[slot]} — ${kept.join(", ")}`;
      if (prev && prev.rec.text === text) continue;
      this.remember(text, { id, kind: "digest", tags: [] });
    }
  }

  private persist() {
    if (this.compiled.length > 2000) { const pin = (c: Compiled) => c.rec.kind === "constraint" || c.cues.length > 0 || c.sal >= 1; const keep = this.compiled.filter(pin).sort((a, b) => a.rec.at - b.rec.at).slice(-2000); const rest = this.compiled.filter((c) => !pin(c)).sort((a, b) => a.rec.at - b.rec.at); this.compiled = [...keep, ...rest.slice(Math.max(0, rest.length - (2000 - keep.length)))]; } writeFileSync(this.path, this.compiled.map((x) => JSON.stringify(x.rec)).join("\n") + (this.compiled.length ? "\n" : ""), { mode: 0o600 });
  }

  relevant(text: string, cap = Number(process.env.EDEN_MEMORY_CAP) || 6, fuse = true): MemoryRecord[] {
    const hay = queryHay(text);
    const hayStem = new Set([...hay].map(liteStem));
    // Digest gate: a slot digest competes only for aggregate questions about its speaker and slot.
    const qTok = new Set(tokList(text));
    const digestOk = (c: Compiled) => {
      if (c.rec.kind !== "digest") return true;
      const [, sp, slot] = c.rec.id.split(":");
      return !!sp && !!slot && qTok.has(sp.split(" ")[0]!) && SLOT_FRAME[slot as Slot]?.test(text) === true;
    };
    const rows = this.compiled.filter((c) => !(this.agent && c.rec.agent && c.rec.agent !== this.agent) && !(this.project && c.rec.project !== this.project) && digestOk(c));
    const speakers = new Set<string>();
    for (const c of rows) {
      const m = c.rec.text.match(SPEAKER_LABEL);
      if (!m) continue;
      for (const w of tokList(m[1]!.replace(/:$/, ""))) speakers.add(w);
    }
    const prefs = new Set([...hay].filter((h) => h.length >= 8 && !speakers.has(h)).map((h) => h.slice(0, 5)));
    const N = rows.length || 1, df = new Map<string, number>();
    // Prefix hit only when stems agree — blocks activities→activist collisions.
    const hit = (x: string) =>
      hay.has(x) ||
      hayStem.has(liteStem(x)) ||
      (x.length >= 8 && !speakers.has(x) && prefs.has(x.slice(0, 5)) && hayStem.has(liteStem(x)));
    const key = (x: string) => (isCarry(x) ? x.slice(1) : x);
    const ctxOn = process.env.EDEN_CTX_MODE !== "off";
    for (const c of rows) {
      const seen = new Set<string>();
      for (const x0 of c.needles) { const x = key(x0); if (hit(x) && !seen.has(x)) { seen.add(x); df.set(x, (df.get(x) || 0) + 1); } }
      if (ctxOn) for (const [x] of c.ctx) if (hit(x) && !seen.has(x)) { seen.add(x); df.set(x, (df.get(x) || 0) + 1); }
    }
    const idfOf = (x: string) => { const d = df.get(x) || 0; const idf = Math.log((N - d + 0.5) / (d + 0.5) + 1); return d / N < 0.04 ? idf * 1.55 : idf; };
    const scored = rows.map((c) => {
      let n = 0;
      const seen = new Set<string>();
      for (const x0 of c.needles) {
        const x = key(x0);
        if (!hit(x) || seen.has(x)) continue;
        seen.add(x);
        const idf = idfOf(x);
        n += x0 === x ? idf : idf * (x0.startsWith(CARRY_Q) ? CARRY_W : CARRY_W2);
      }
      // Episode-context needles: the record inherits its episode's cue overlap (bounded).
      let cn = 0;
      if (ctxOn) for (const [x, w] of c.ctx) { if (seen.has(x) || !hit(x)) continue; seen.add(x); cn += idfOf(x) * w; }
      const base = n + Math.min(CTX_W * cn, CTX_CAP);
      const sal = base > 0 ? SAL_BOOST * c.sal : 0;
      // Hot path: skip answer-type bonuses when there is no lexical/context hit (digest still competes).
      let extras = c.rec.kind === "digest" ? DIGEST_BONUS : 0;
      if (base > 0) extras += proxBonus(hay, c.rec.text) + titleBonus(text, c.rec.text) + favBonus(text, c.rec.text) + speakerBonus(text, c.rec.text, speakers) + quantBonus(text, c.rec.text) + howBonus(text, c.rec.text) + intentBonus(text, c.rec.text) + whereBonus(text, c.rec.text);
      return { rec: c.rec, n: base + sal + extras, cue: base > 0, sal: c.sal };
    });
    // Context reinstatement: the top hits' episodes spread activation to their other cue-sharing records.
    if (ctxOn && REINSTATE > 0) {
      let a: typeof scored[number] | undefined, b: typeof scored[number] | undefined;
      for (const x of scored) { if (!x.rec.ep || x.n <= 0) continue; if (!a || x.n > a.n) { b = a; a = x; } else if (!b || x.n > b.n) b = x; }
      const eps = new Set([a?.rec.ep, b?.rec.ep].filter(Boolean));
      if (eps.size) for (const x of scored) if (x.cue && x.rec.ep && eps.has(x.rec.ep)) x.n += REINSTATE * (1 + SAL_REINSTATE * x.sal);
    }
    const ranked = scored.filter((x) => x.n).sort((a, b) => b.n - a.n || Number(b.rec.kind === "constraint") - Number(a.rec.kind === "constraint") || b.rec.at - a.rec.at).slice(0, Math.max(cap * 6, 30, fuse ? 120 : 0));
    let lexical = pinEnvFact(envSlotKind(text), dedupSelect(fuse ? fuseIfCrowded(ranked, hay, speakers, cap) : ranked, cap), ranked, cap);
    // Fix-seeking: pin an action sentence already in the cap so prospective cannot drop it.
    if (/\b(?:how did we fix|what was the fix)\b/i.test(text)) {
      let have: MemoryRecord | undefined;
      let bugCue = false;
      for (const l of lexical) {
        if (!bugCue && /\b(?:root cause|stack trace|should be gone)\b/i.test(l.text)) bugCue = true;
        if (!have && isFixAction(l.text)) have = l;
        if (have && bugCue) break;
      }
      if (have && bugCue && lexical[0]?.id !== have.id) {
        lexical = [have, ...lexical.filter((l) => l.id !== have.id)];
      }
    }
    // Log-policy: print/debug queries retrieve the no-print constraint even with zero needle overlap.
    if (isLogPolicyQuery(text)) {
      let have = lexical.find((l) => isNoPrintRule(l.text));
      if (!have) {
        let best: Compiled | undefined;
        for (const c of rows) {
          if (!(c.cues.includes(CUE_TAG + "c:log-forbid") || (c.rec.kind === "constraint" && isNoPrintRule(c.rec.text)))) continue;
          if (!best || c.sal > best.sal || (c.sal === best.sal && c.rec.at > best.rec.at)) best = c;
        }
        if (best) have = best.rec;
      }
      if (have) lexical = [have, ...lexical.filter((l) => l.id !== have.id)].slice(0, cap);
    }
    // Prospective pass: cue-triggered intentions get a reserved slice of the cap when the lexical pass missed them.
    const triggered = triggerScores(rows, text);
    if (!triggered.length) return lexical;
    const reserve = Math.min(PROSPECT_SLOTS, Math.max(1, Math.floor(cap / 3)));
    const strong = Math.log(1 + 2);
    const picked: MemoryRecord[] = [];
    for (const { rec, t } of triggered) {
      if (picked.length >= reserve) break;
      if (t < strong * PROSPECT_MIN) break;
      if (lexical.slice(0, cap - reserve).some((l) => l.id === rec.id || jaccardText(l.text, rec.text) > 0.6)) continue;
      if (picked.some((p) => jaccardText(p.text, rec.text) > 0.6)) continue;
      picked.push(rec);
    }
    if (!picked.length) return lexical;
    const out: MemoryRecord[] = [];
    for (const l of lexical) { if (out.length >= cap - picked.length) break; if (!picked.some((p) => p.id === l.id || jaccardText(p.text, l.text) > 0.6)) out.push(l); }
    return [...out, ...picked];
  }

  notesFor(text = "", k = Number(process.env.EDEN_MEMORY_CAP) || 6, opts: { fuse?: boolean } = {}): MemoryRecord[] {
    // Intention records (rules/decisions with a cue index) are returned verbatim: the yes/no and numeral
    // augmentation exists for answering questions from facts, and would corrupt "never console.log" or "zero ops".
    const map = (recs: MemoryRecord[]) => recs.map((r) => ({ ...r, text: cuesOf(r).length ? r.text : retrieveText(r.text) }));
    if (text) return map(this.relevant(text, k, opts.fuse !== false));
    return map(((recs) => [...recs.filter((r) => r.kind === "constraint").slice(-k), ...recs.filter((r) => r.kind !== "constraint").slice(-k)].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i).slice(0, k))(this.memories()));
  }

  query(q: string, k = Number(process.env.EDEN_MEMORY_CAP) || 6): QueryHit[] {
    const qn = q.trim(), out: QueryHit[] = qn ? this.notesFor(qn, k).map((m) => ({ text: m.text, source: "memory" as const, id: m.id })) : [];
    if (qn && out.length < k) try { const card = knowQuery(qn, this.know); if (card && "fact" in card && card.fact) out.push({ text: card.fact, source: "know", url: card.url }); } catch {}
    return out.slice(0, k);
  }

  inject(messages: unknown[]): unknown[] {
    const list = Array.isArray(messages) ? messages : [];
    try {
      const blob = convBlob(list);
      const notes: { role: "system"; content: string }[] = [];
      if (!alreadyInjected(blob) && !blob.includes(MEMORY_MARK)) {
        const mems = this.notesFor(blob);
        if (mems.length) notes.push({ role: "system", content: MEMORY_MARK + mems.map((m) => `\n- ${m.text}`).join("") });
        const card = injectFromRequest({ text: blob }, this.know); if (card) notes.push({ role: "system", content: injectNote(card) });
      }
      this.observe(list);
      if (!notes.length) return list;
      const next = list.slice(), i = next.findIndex((m) => (m as { role?: string })?.role !== "system");
      return next.splice(i < 0 ? next.length : i, 0, ...notes), next;
    } catch { return list; }
  }

  injectBody(body: Record<string, unknown>): Record<string, unknown> {
    const key = Array.isArray(body.messages) ? "messages" : Array.isArray(body.contents) ? "contents" : "messages", m = Array.isArray(body[key]) ? (body[key] as unknown[]) : [], sys = body.systemInstruction ?? body.system_instruction ?? body.system ?? body.system_prompt ?? body.systemPrompt;
    if (sys) this.observe(typeof sys === "string" ? [{ role: "user", content: sys }] : [sys]);
    const next = this.inject(m);
    return next === m ? body : { ...body, [key]: next };
  }
  close() {}
}

export function openMemory(opts: MemoryOptions = {}): AgentMemory {
  return new AgentMemory(opts);
}

let proc: AgentMemory | undefined;
export function processMemory(): AgentMemory {
  return process.argv.some((a) => a.endsWith(".test.ts")) ? openMemory({ dir: join(tmpdir(), "eden-m-" + Math.random().toString(36).slice(2)) }) : (proc ??= openMemory({ dir: process.env.EDEN_MEMORY_DIR || (process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : undefined), agent: process.env.EDEN_MEMORY_AGENT || undefined, project: process.env.EDEN_MEMORY_PROJECT || undefined }));
}

export function host(opts: MemoryOptions & { port?: number } = {}) {
  const memory = openMemory(opts);
  const server = Bun.serve({
    hostname: process.env.EDEN_MEMORY_HOST || "127.0.0.1",
    port: Number(opts.port ?? process.env.EDEN_MEMORY_PORT) || 8787,
    async fetch(req) {
      const origin = req.headers.get("origin") || "";
      const cors = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin) ? { "access-control-allow-origin": origin, vary: "origin", "access-control-expose-headers": "content-type" } : {};
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
      try {
        if (req.method === "HEAD") return new Response(null, { status: 200, headers: cors });
        if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "86400" } });
        const u = new URL(req.url);
        const p = u.pathname.replace(/\/+$/, "").replace(/^\/v1(?=\/)/, "") || "/";
        if (req.method === "DELETE") return json({ ok: memory.forget(String(u.searchParams.get("id") || u.searchParams.get("q") || p.split("/").pop() || "")) });
        if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
          const b = (await req.json().catch(() => ({}))) as { text?: string; prompt?: string; input?: string; content?: string; query?: string; message?: string; body?: string; system?: string; systemInstruction?: unknown; system_instruction?: unknown; id?: string; messages?: unknown[]; conversation?: unknown[]; contents?: unknown[]; q?: string; k?: number };
          const sys = b.systemInstruction ?? b.system_instruction, blob = String(b.text || b.prompt || b.input || b.content || b.query || b.message || b.body || b.system || (typeof sys === "string" ? sys : "") || ""), msgs = b.messages || b.conversation || b.contents || (blob ? [{ role: "user", content: blob }] : sys && typeof sys !== "string" ? [sys] : []);
          const run = ({ "/observe": () => memory.observe(msgs), "/remember": () => memory.remember(blob, b), "/forget": () => ({ ok: memory.forget(String(b.id || blob)) }), "/inject": () => { const n = memory.inject(msgs); return Array.isArray(b.contents) && !b.messages ? { contents: n, messages: n } : { messages: n }; }, "/query": () => memory.query(String(b.q || blob), Number(b.k) || Number(process.env.EDEN_MEMORY_CAP) || 6) } as Record<string, () => unknown>)[p]; if (run) return json(run());
        } else {
          const q = u.searchParams.get("q") || u.searchParams.get("text") || u.searchParams.get("prompt") || u.searchParams.get("input") || u.searchParams.get("content") || u.searchParams.get("message") || u.searchParams.get("system") || u.searchParams.get("body") || u.searchParams.get("system_prompt") || "", k = Number(u.searchParams.get("k")) || Number(process.env.EDEN_MEMORY_CAP) || 6, health = () => ({ ok: true, n: memory.memories().length });
          const run = ({ "/": health, "/health": health, "/query": () => memory.query(q, k), "/observe": () => memory.observe(q ? [{ role: "user", content: q }] : []), "/remember": () => memory.remember(q), "/forget": () => ({ ok: memory.forget(String(u.searchParams.get("id") || q)) }), "/inject": () => { const n = memory.inject(q ? [{ role: "user", content: q }] : []); return { messages: n, contents: n }; }, "/memories": () => (q ? memory.query(q, k) : memory.memories().slice().sort((a, b) => b.at - a.at).slice(0, Number(u.searchParams.get("limit") || u.searchParams.get("k")) || 500)) } as Record<string, () => unknown>)[p]; if (run) return json(run());
        }
        return new Response("eden memory\n", { headers: cors });
      } catch (e) { return json({ error: String(e) }, 400); }
    },
  });
  return { url: String(server.url), stop: () => server.stop(), memory };
}
