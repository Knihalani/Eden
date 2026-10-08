/**
 * M8.3 / M22.1 / M28.1 completion / CAR: walk the current fact graph (Self-Ask chain, else next-fact).
 * max(t) per (s, p) so overwritten hops die; last hop is ranked / injected first.
 * Per hop: top-k lexical rows for the current entity, not 3 BM25 rounds on the rarest `#`.
 * Narrative 512-token chunks expand into hop sentences before the walk (not GraphRAG, not ICL).
 * No network, no extra LLM. Fail-open.
 */
import { isIclExemplar } from "../semantic-store";

export type HopSource = { text: string; at?: number; i?: number; id?: string; kind?: string; tags?: string[] };

export type HopFact = {
  s: string;
  p: string;
  o: string;
  t: number;
  text: string;
  i: number;
  id?: string;
};

/**
 * Cap on a CAR walk. Official FC-MH has 3-hop (position→sport→country) and 4-hop (author→spouse→citizen→continent)
 * chains. Not unbounded BM25.
 */
const MAX_HOPS = 4;
const HOP_K = 10;
/** Observe's Date.now() (~1e12). Serial t=8 must beat wall-clock ice hockey. */

const REL_ALIASES: Record<string, string> = {
  author: "author",
  writer: "author",
  wrote: "author",
  spouse: "spouse",
  wife: "spouse",
  husband: "spouse",
  married: "spouse",
  citizen: "citizen",
  nationality: "citizen",
  country: "citizen",
  chairperson: "chairperson",
  chair: "chairperson",
  born: "born",
  birthplace: "born",
  birth: "born",
  position: "position",
  director: "director",
  directed: "director",
  based: "based",
  population: "population",
  portrayed: "portrayed",
  portray: "portrayed",
  magic: "magic",
  number: "number",
};

const REL_ALT = Object.keys(REL_ALIASES).join("|");

const QUERY_STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "how",
  "when",
  "where",
  "why",
  "to",
  "in",
  "on",
  "for",
  "and",
  "or",
  "from",
  "at",
  "by",
  "as",
  "that",
  "this",
  "these",
  "those",
  "with",
  "into",
  "than",
  "then",
  "so",
  "if",
  "not",
  "no",
  "yes",
  "it",
  "its",
  "his",
  "her",
  "their",
  "our",
  "your",
  "my",
  "do",
  "does",
  "did",
]);

function clip(s: string): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
}

function normEnt(s: string): string {
  let x = clip(s).toLowerCase();
  while (/^(?:the|a|an)\s+/.test(x)) x = x.replace(/^(?:the|a|an)\s+/, "");
  return x.replace(/[^a-z0-9]+/g, " ").trim();
}

function stripRole(s: string): string {
  let x = clip(s);
  x = x.replace(/^(?:players?|authors?|writers?)\s+/i, "");
  return x.trim();
}

export function canonRel(p: string): string {
  const x = clip(p)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (REL_ALIASES[x]) return REL_ALIASES[x]!;
  for (const [k, v] of Object.entries(REL_ALIASES)) {
    if (x.includes(k)) return v;
  }
  const toks = x.split(/\s+/).filter((t) => t.length >= 3 && !QUERY_STOP.has(t));
  if (toks.length > 1) return toks[toks.length - 1]!;
  return x;
}

/** Same provenance brackets as assemble: `[kind]`, `[kind · 3h · user]`, `[procedure · verified]`. */
const PACKET_DECOR_RE = /^\[(?:rule|fact|episode|gist|procedure)(?:\s*[·|][^\]]*)?\]\s+/i;

function stripPacketDecor(text: string): string {
  let t = clip(String(text ?? "").replace(/^[-*]\s+/, ""));
  for (let i = 0; i < 8; i++) {
    const next = clip(t.replace(PACKET_DECOR_RE, ""));
    if (next === t) break;
    t = next;
  }
  return t;
}

/** A fact's time: its row's, else its position; a list number is not a time (A1 D8). */
function factTime(at: number | undefined, idx: number): number {
  return at != null && Number.isFinite(at) ? at : idx;
}

/** The newer fact per (s, p): the later time, then the later row. */
function factBeats(a: HopFact, b: HopFact): boolean {
  if (a.t !== b.t) return a.t > b.t;
  return a.i > b.i;
}

function bodyOf(text: string): string {
  return clip(stripPacketDecor(text).replace(/^\s*\d+[.)]\s+/, ""));
}

const PACKET_KINDS = new Set(["rule", "fact", "episode", "gist", "procedure"]);

function packetKindPrefix(row: HopSource): string {
  const kind = String(row.kind ?? "");
  const tags = row.tags ?? [];
  if (kind === "constraint") return "[rule] ";
  if (kind === "digest" || kind === "gist" || tags.some((t) => t === "gist" || t === "digest")) return "[gist] ";
  if (kind === "episode") return "[episode] ";
  if (kind === "fact" || kind === "preference") return "[fact] ";
  if (kind === "procedure") return "[procedure] ";
  return "";
}

/** Copy so we never mutate JSONL rows. Do not invent `[procedure]`. */
function ensurePacketLabel<T extends HopSource>(rec: T): T {
  const text = String(rec.text ?? "").trim();
  const existing = text.match(/^\[(rule|fact|episode|gist|procedure)(?:\s*[·|][^\]]*)?\]\s+/i);
  if (existing && PACKET_KINDS.has(existing[1]!.toLowerCase())) return rec;
  const prefix = packetKindPrefix(rec);
  if (!prefix) return rec;
  return { ...rec, text: prefix + String(rec.text).replace(/^\s+/, "") };
}

function skipGraphText(text: string): boolean {
  const t = String(text ?? "");
  if (isIclExemplar(t) || /\blabel\s*:/i.test(t)) return true;
  return false;
}

function hopSentences(text: string): string[] {
  const t = String(text ?? "");
  if (!t.trim()) return [];
  return t
    .split(/(?<=[.!?])\s+|(?<=\.)\n/)
    .map((s) =>
      String(s ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((s) => s.length >= 8);
}

/** Proper name or hyphenated id — not miller prose objects. */
function looksHopAlias(o: string): boolean {
  const t = clip(o);
  if (!t || t.length < 2) return false;
  if (/^[A-Z][A-Za-z0-9]*(?:[\s-][A-Z][A-Za-z0-9]*)+$/.test(t)) return true;
  if (/^[A-Z][a-zA-Z]{2,}$/.test(t)) return true;
  if (/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(t) && /[A-Z0-9]/.test(t)) return true;
  return false;
}

/**
 * M28.1: walk copula/Wikipedia hops inside 512-token chunks. EventQA miller
 * prose yields zero triples (not GraphRAG). ICL stays skipped. Short FC-MH
 * fact rows are unchanged.
 */
function expandHopRows(rows: HopSource[]): HopSource[] {
  const out: HopSource[] = [];
  for (const row of rows) {
    if (!row) continue;
    const text = String(row.text ?? "");
    if (skipGraphText(text)) continue;
    const sents = hopSentences(text);
    const long = text.length > 400 && sents.length >= 2;
    if (!long) {
      out.push(row);
      continue;
    }
    for (const sent of sents) {
      if (skipGraphText(sent)) continue;
      if (!extractTriple(sent)) continue;
      out.push({ ...row, text: sent });
    }
  }
  return out;
}

function contentTokens(q: string): string[] {
  return normEnt(q)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !QUERY_STOP.has(t));
}

function sameEntity(a: string, b: string): boolean {
  const na = normEnt(a),
    nb = normEnt(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  const aToks = na.split(/\s+/).filter(Boolean);
  const bToks = nb.split(/\s+/).filter(Boolean);
  const [short, long] = aToks.length <= bToks.length ? [aToks, new Set(bToks)] : [bToks, new Set(aToks)];
  return short.length > 0 && short.every((t) => long.has(t));
}

function mentionsEntity(body: string, entity: string): boolean {
  const b = normEnt(body),
    ent = normEnt(entity);
  if (!b || !ent) return false;
  if (` ${b} `.includes(` ${ent} `)) return true;
  const eToks = ent.split(/\s+/).filter((t) => t.length >= 2);
  const bSet = new Set(b.split(/\s+/));
  if (eToks.length && eToks.every((t) => bSet.has(t))) return true;
  return eToks.some((t) => t.length >= 4 && bSet.has(t));
}

function queryMentionsEntity(qBody: string, qToks: Set<string>, entity: string): boolean {
  const ent = normEnt(entity);
  if (!ent) return false;
  if (` ${qBody} `.includes(` ${ent} `)) return true;
  const eToks = ent.split(/\s+/).filter(Boolean);
  if (eToks.length && eToks.every((t) => qToks.has(t) || qBody.includes(t))) return true;
  return eToks.some((t) => t.length >= 4 && qToks.has(t));
}

/** Typed (s, p, o) from copula / married / citizen / author-of, then general SVO. ICL is skipped. */
export function extractTriple(text: string): { s: string; p: string; o: string } | undefined {
  if (skipGraphText(text)) return undefined;
  // bodyOf/clip strips trailing `?`, so interrogatives must be rejected on the source text.
  // Otherwise a stored chat cue ("…is based in Brooklyn?") becomes a fake director hop.
  if (/\?/.test(String(text ?? ""))) return undefined;
  const raw = bodyOf(text);
  if (!raw || raw.endsWith("?") || /\bis based in (?:what|which|who|where)\b/i.test(raw)) return undefined;

  const take = (s: string, p: string, o: string) => {
    const ns = stripRole(normEnt(s)),
      np = canonRel(p),
      no = normEnt(o);
    if (!ns || !np || !no || ns === no) return undefined;
    // Question tails belong on the object ("based in what city"), not "who portrayed".
    if (
      no
        .split(/\s+/)
        .some((t) => t === "what" || t === "which" || t === "who" || t === "where" || t === "whom" || t === "how")
    )
      return undefined;
    return { s: ns, p: np, o: no };
  };

  let m = raw.match(/^(?:the\s+)?author\s+of\s+(.+?)\s+(?:is|was|are|were)\s+(.+)$/i);
  if (m) return take(m[1]!, "author", m[2]!);

  m = raw.match(/^(?:the\s+)?(?:writer|written by)\s+of\s+(.+?)\s+(?:is|was|are|were)\s+(.+)$/i);
  if (m) return take(m[1]!, "author", m[2]!);

  m = raw.match(/^(?:the\s+)?chairperson\s+of\s+(.+?)\s+(?:is|was|are|were)\s+(.+)$/i);
  if (m) return take(m[1]!, "chairperson", m[2]!);

  m = raw.match(/^(.+?)\s+(?:is|was|are|were)\s+married\s+to\s+(.+)$/i);
  if (m) return take(m[1]!, "spouse", m[2]!);

  m = raw.match(/^(.+?)\s+(?:is|was|are|were)\s+(?:the\s+)?(?:spouse|wife|husband)\s+of\s+(.+)$/i);
  if (m) return take(m[2]!, "spouse", m[1]!);

  m = raw.match(/^(.+?)\s+(?:is|was|are|were)\s+(?:a|an)\s+citizen\s+of\s+(.+)$/i);
  if (m) return take(m[1]!, "citizen", m[2]!);

  m = raw.match(/^(.+?)\s+(?:is|was|are|were)\s+a\s+(?:national|citizen)\s+(?:of|from)\s+(.+)$/i);
  if (m) return take(m[1]!, "citizen", m[2]!);

  m = raw.match(/^(.+?)\s+(?:was|is)\s+born\s+in(?:\s+the\s+(?:city|town)\s+of)?\s+(.+)$/i);
  if (m) return take(m[1]!, "born", m[2]!);

  m = raw.match(/^(.+?)\s+plays\s+the\s+position\s+of\s+(.+)$/i);
  if (m) return take(m[1]!, "position", m[2]!);

  m = raw.match(/^(?:one of\s+)?(?:the\s+)?special\s+magic\s+numbers?\s+(?:of|for)\s+(.+?)\s+is:?\s+(.+)$/i);
  if (m) return take(m[1]!, "magic", m[2]!);

  m = raw.match(/^(.+?)\s+(?:was|is|were|are)\s+directed by\s+(.+)$/i);
  if (m) return take(m[1]!.replace(/^(?:the\s+)?(?:romantic comedy|film|movie)\s+/i, ""), "director", m[2]!);

  m = raw.match(
    new RegExp(
      String.raw`^(?:the\s+)?director of\s+(?:the\s+)?(?:romantic comedy|film|movie)?\s*[""]?(.+?)[""]?\s+` +
        String.raw`(?:is|was|are|were)\s+(.+)$`,
      "i",
    ),
  );
  if (m && !/^(?:based|located|born|from|directed)\b/i.test(clip(m[2]!))) return take(m[1]!, "director", m[2]!);

  m = raw.match(/^(.+?)\s+(?:is|was|are|were)\s+based in\s+(.+)$/i);
  if (m) return take(m[1]!, "based", m[2]!);

  m = raw.match(/^(?:the\s+)?population of\s+(.+?)\s+(?:is|was)\s+(.+)$/i);
  if (m) return take(m[1]!, "population", m[2]!);

  m = raw.match(/^(.+?)\s+has a population of\s+(.+)$/i);
  if (m) return take(m[1]!, "population", m[2]!);

  m = raw.match(
    new RegExp(
      String.raw`^(.+?)\s+(?:is|was|are|were)\s+(?:the\s+)?` +
        String.raw`(?:woman|man|actor|actress|person)\s+who\s+portrayed\s+(.+?)(?:\s+in\b|$)`,
      "i",
    ),
  );
  if (m) return take(m[2]!, "portrayed", m[1]!);

  m = raw.match(
    /^(?:the\s+)?(?:woman|man|actor|actress|person)\s+who\s+portrayed\s+(.+?)\s+(?:is|was|are|were)\s+(.+)$/i,
  );
  if (m) return take(m[1]!, "portrayed", m[2]!);

  m = raw.match(/^(.+?)\s+portrayed\s+(.+?)(?:\s+in\b|\s*$)/i);
  if (m) return take(m[2]!, "portrayed", m[1]!);

  m = raw.match(/^(.+?)\s+(?:held|holds)\s+(?:the\s+)?(?:government\s+)?position\s+of\s+(.+)$/i);
  if (m) return take(m[1]!, "position", m[2]!);

  // Official FC-MH frames (not REL_ALIASES): associated/created/affiliated/located.
  m = raw.match(
    new RegExp(
      String.raw`^(.+?)\s+(?:is|was|are|were)\s+` +
        String.raw`(?:associated with|affiliated with|located in|created in)\s+(?:the\s+)?([a-z]+)\s+of\s+(.+)$`,
      "i",
    ),
  );
  if (m) return take(m[1]!, m[2]!, m[3]!);

  m = raw.match(/^(.+?)\s+(?:is|was|are|were)\s+associated with\s+(.+)$/i);
  if (m && looksHopAlias(m[2]!)) return take(m[1]!, "associated", m[2]!);

  m = raw.match(/^(.+?)\s+plays(?!\s+the\s+position\b)\s+(.+)$/i);
  if (m) return take(m[1]!, "plays", m[2]!);

  m = raw.match(/^(.+?)\s+originated\s+in\s+(.+)$/i);
  if (m) return take(m[1]!, "originated", m[2]!);

  m = raw.match(/^(.+?)\s+(?:is|was|are|were)\s+from\s+(.+)$/i);
  if (m) return take(m[1]!, "from", m[2]!);

  m = raw.match(/^(.+?)\s+comes?\s+from\s+(.+)$/i);
  if (m) return take(m[1]!, "from", m[2]!);

  m = raw.match(/^(?:the\s+)?([a-z]+(?:\s+[a-z]+){0,3})\s+of\s+(.+?)\s+(?:is|was|are|were)\s+(?:now\s+)?(.+)$/i);
  if (m) {
    const rel = m[1]!.toLowerCase();
    const last = rel
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !QUERY_STOP.has(t))
      .pop();
    if (last && last.length >= 3 && !QUERY_STOP.has(last)) return take(m[2]!, last, m[3]!);
  }

  return undefined;
}

function maxPerKey(rows: HopSource[]): HopFact[] {
  const best = new Map<string, HopFact>();
  rows.forEach((row, idx) => {
    const trip = extractTriple(row.text);
    if (!trip) return;
    const t = factTime(row.at, idx);
    const i = row.i ?? idx;
    const fact: HopFact = { ...trip, t, text: row.text, i, id: row.id };
    const k = `${fact.s}\0${fact.p}`;
    const prev = best.get(k);
    if (!prev || factBeats(fact, prev)) best.set(k, fact);
  });
  return [...best.values()];
}

function lookup(s: string, p: string, facts: HopFact[]): HopFact | undefined {
  const ns = normEnt(s),
    np = canonRel(p);
  if (!ns || !np) return undefined;
  let hit: HopFact | undefined;
  for (const f of facts) {
    if (f.p !== np) continue;
    if (!sameEntity(f.s, ns)) continue;
    if (!hit || factBeats(f, hit)) hit = f;
  }
  return hit;
}

type Chain = { seed: string; rels: string[] };

function parseSelfAsk(q: string): Chain | null {
  const raw = clip(String(q ?? "")).replace(/\?+$/, "");
  if (!raw) return null;
  // EventQA "What happened at Blackford mill?" is not a hop chain.
  if (/\bwhat happened\b/i.test(raw)) return null;
  // "country of origin of the sport played by X" is not citizen-of-X. Let BFS walk position→sport→country.
  if (/\bsport\s+played\s+by\b|\bcountry of origin of the sport\b/i.test(raw)) return null;

  const ofRe = new RegExp(`\\bthe\\s+(${REL_ALT})\\s+of\\b`, "gi");
  const ofRels: string[] = [];
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = ofRe.exec(raw))) {
    ofRels.push(canonRel(m[1]!));
    last = m;
  }

  let seed = "";
  const extra: string[] = [];
  if (last) {
    seed = clip(raw.slice(last.index + last[0].length));
    const trail = seed.match(new RegExp(`\\s+(?:a|an|the)?\\s*(${REL_ALT})\\s+of\\s*$`, "i"));
    if (trail) {
      extra.push(canonRel(trail[1]!));
      seed = clip(seed.slice(0, trail.index));
    }
    seed = seed
      .replace(/^(?:the|a|an)\s+/i, "")
      .replace(/[.,;:]+$/g, "")
      .trim();
  }

  const quoted = raw.match(/["“]([^"”]{2,80})["”]/);
  if (quoted && ofRels.length) {
    seed = clip(quoted[1]!);
  } else if (seed) {
    seed = seed.replace(/^(?:the\s+)?(?:romantic comedy|film|movie)\s+/i, "");
    seed = seed.replace(/\s+(?:is|was|are|were)\s+based in\b[\s\S]*$/i, "");
    seed = seed.replace(/\s+in what\b[\s\S]*$/i, "");
  }

  if (!ofRels.length) {
    const poss = raw.match(new RegExp(`([A-Z][A-Za-z]+(?:\\s+[A-Z][A-Za-z]+)*)'s\\s+(${REL_ALT})\\b`));
    if (poss) {
      seed = clip(poss[1]!);
      ofRels.push(canonRel(poss[2]!));
    }
  }

  if (!ofRels.length) {
    const who = raw.match(
      /\b(?:(?:the\s+)?(?:woman|man|actor|actress|person)\s+)?who\s+portrayed\s+(.+?)(?:\s+in\s+.+)?$/i,
    );
    if (who) {
      seed = clip(who[1]!);
      ofRels.push("portrayed");
    }
  }

  if (/\bwhich country\b/i.test(raw) && ![...ofRels, ...extra].includes("citizen")) extra.push("citizen");
  if (/\bbased in\b/i.test(raw) && ![...ofRels, ...extra].includes("based")) extra.push("based");
  if (/\bpopulation\b/i.test(raw) && ![...ofRels, ...extra].includes("population")) extra.push("population");
  if (/\bportrayed\b/i.test(raw) && ![...ofRels, ...extra].includes("portrayed")) extra.push("portrayed");
  if (/\bpositions?\b/.test(raw) && ![...ofRels, ...extra].includes("position")) extra.push("position");

  const rels = [...ofRels].reverse().concat(extra);
  if (!seed || !rels.length) return null;
  return { seed, rels: rels.slice(0, MAX_HOPS) };
}

function lexicalScore(body: string, entity: string, extra: string[]): number {
  const b = normEnt(body),
    ent = normEnt(entity);
  if (!b || !ent) return 0;
  const bSet = new Set(b.split(/\s+/));
  let score = 0;
  if (` ${b} `.includes(` ${ent} `)) score += 10;
  for (const t of ent.split(/\s+/)) if (t.length >= 2 && bSet.has(t)) score += 3;
  for (const t of extra) {
    const n = normEnt(t);
    if (n.length >= 4 && bSet.has(n)) score += 2;
    else if (n.length >= 3 && bSet.has(n)) score += 1;
  }
  return score;
}

function topKForEntity(entity: string, rows: HopSource[], extra: string[], k = HOP_K): HopSource[] {
  const ent = normEnt(entity);
  if (!ent) return [];
  const scored: { row: HopSource; score: number; t: number; i: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (skipGraphText(row.text)) continue;
    const body = bodyOf(row.text) || String(row.text ?? "");
    if (!mentionsEntity(body, ent)) continue;
    const t = factTime(row.at, i);
    scored.push({ row, score: lexicalScore(body, ent, extra), t, i });
  }
  scored.sort((a, b) => b.score - a.score || b.t - a.t || b.i - a.i);
  return scored.slice(0, k).map((s) => s.row);
}

function topKForQuery(rows: HopSource[], qToks: string[], k = HOP_K): HopSource[] {
  const scored: { row: HopSource; score: number; t: number; i: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (skipGraphText(row.text)) continue;
    const body = normEnt(bodyOf(row.text) || String(row.text ?? ""));
    if (!body) continue;
    const bSet = new Set(body.split(/\s+/));
    let score = 0;
    for (const n of qToks) {
      if (n.length >= 4 && bSet.has(n)) score += 3;
      else if (n.length >= 3 && bSet.has(n)) score += 1;
    }
    if (score <= 0) continue;
    const t = factTime(row.at, i);
    scored.push({ row, score, t, i });
  }
  scored.sort((a, b) => b.score - a.score || b.t - a.t || b.i - a.i);
  return scored.slice(0, k).map((s) => s.row);
}

function factsForEntity(entity: string, rows: HopSource[], qToks: string[]): HopFact[] {
  return maxPerKey(topKForEntity(entity, rows, qToks));
}

function overlapScore(fact: HopFact, qToks: Set<string>): number {
  let n = 0;
  for (const t of normEnt(fact.p).split(/\s+/)) {
    if (!t) continue;
    if (qToks.has(t)) n += 4;
    else {
      for (const q of qToks) {
        if (canonRel(q) === fact.p) {
          n += 4;
          break;
        }
      }
    }
  }
  for (const t of normEnt(fact.o).split(/\s+/)) if (t && qToks.has(t)) n += 2;
  return n;
}

/** Query nouns that should be a last hop. sport/plays/originated stay out of REL_ALIASES. */
function wantedRels(q: string): Set<string> {
  const raw = clip(String(q ?? "")).toLowerCase();
  const want = new Set<string>();
  for (const [k, v] of Object.entries(REL_ALIASES)) {
    if (raw.includes(k)) want.add(v);
  }
  if (/\bcontinents?\b/.test(raw)) want.add("continent");
  if (/\breligions?\b/.test(raw)) want.add("religion");
  if (/\bsports?\b/.test(raw)) want.add("sport");
  if (/\borigin/.test(raw)) want.add("originated");
  if (/\b(?:play|plays|played|playing)\b/.test(raw)) want.add("plays");
  if (/\bpositions?\b/.test(raw)) want.add("position");
  if (/\bcountr(?:y|ies)\b|\bcitizen/.test(raw)) want.add("citizen");
  if (/\bbased in\b|\bnew york city\b/.test(raw)) want.add("based");
  if (/\bdirect(?:or|ed)\b/.test(raw)) want.add("director");
  if (/\bpopulation\b|\binhabitants?\b/.test(raw)) want.add("population");
  if (/\bportrayed\b/.test(raw)) want.add("portrayed");
  if (/\bmagic number/.test(raw)) want.add("magic");
  return want;
}

/** Drop overshoot hops (continent after a country question). Keep the last hop the query asked for. */
function trimToQuery(hops: HopFact[], q: string): HopFact[] {
  if (hops.length <= 1) return hops;
  const want = wantedRels(q);
  if (!want.size) return hops;
  for (let i = hops.length - 1; i >= 0; i--) {
    const p = hops[i]!.p;
    if (want.has(p) || want.has(canonRel(p))) return hops.slice(0, i + 1);
  }
  return hops;
}

function extendHops(hops: HopFact[], rows: HopSource[], qToks: string[]): HopFact[] {
  if (!hops.length) return hops;
  const seen = new Set<string>();
  for (const h of hops) {
    seen.add(normEnt(h.s));
    seen.add(normEnt(h.o));
  }
  let cur = hops[hops.length - 1]!.o;
  const out = hops.slice();
  while (out.length < MAX_HOPS) {
    const facts = factsForEntity(cur, rows, qToks);
    const fact = pickOutgoing(cur, facts, qToks, seen);
    if (!fact) break;
    out.push(fact);
    seen.add(normEnt(fact.o));
    cur = fact.o;
  }
  return out;
}

function pickOutgoing(ent: string, facts: HopFact[], qToks: string[], seen: Set<string>): HopFact | undefined {
  const qSet = new Set(qToks);
  let best: HopFact | undefined;
  let bestOverlap = -1;
  for (const f of facts) {
    if (!sameEntity(f.s, ent)) continue;
    if (seen.has(normEnt(f.o))) continue;
    const ov = overlapScore(f, qSet);
    if (!best || ov > bestOverlap || (ov === bestOverlap && factBeats(f, best))) {
      best = f;
      bestOverlap = ov;
    }
  }
  return best;
}

function walkChain(seed: string, rels: string[], rows: HopSource[], qToks: string[]): HopFact[] {
  const hops: HopFact[] = [];
  let cur = seed;
  const seen = new Set<string>([normEnt(cur)]);
  for (const rel of rels) {
    if (hops.length >= MAX_HOPS) break;
    const facts = factsForEntity(cur, rows, qToks);
    let fact = lookup(cur, rel, facts);
    if (!fact) fact = pickOutgoing(cur, facts, qToks, seen);
    if (!fact) break;
    hops.push(fact);
    seen.add(normEnt(fact.o));
    cur = fact.o;
  }
  return hops;
}

function entitiesInQuery(q: string, rows: HopSource[]): string[] {
  const qBody = normEnt(q);
  const qToks = new Set(contentTokens(q));
  const top = topKForQuery(rows, [...qToks]);
  const facts = maxPerKey(top);
  const seen = new Set<string>();
  const out: string[] = [];
  const consider = (e: string) => {
    if (!e || seen.has(e) || e.length < 4) return;
    if (!queryMentionsEntity(qBody, qToks, e)) return;
    seen.add(e);
    out.push(e);
  };
  for (const f of facts) consider(f.s);
  for (const f of facts) consider(f.o);
  return out;
}

function greedyWalk(seed: string, rows: HopSource[], qToks: string[]): HopFact[] {
  const hops: HopFact[] = [];
  let cur = seed;
  const seen = new Set<string>([normEnt(cur)]);
  while (hops.length < MAX_HOPS) {
    const facts = factsForEntity(cur, rows, qToks);
    const fact = pickOutgoing(cur, facts, qToks, seen);
    if (!fact) break;
    hops.push(fact);
    seen.add(normEnt(fact.o));
    cur = fact.o;
  }
  return hops;
}

function bfsHops(q: string, rows: HopSource[]): HopFact[] {
  const qToks = contentTokens(q);
  const seeds = entitiesInQuery(q, rows);
  if (!seeds.length) return [];
  let best: HopFact[] = [];
  for (const seed of seeds) {
    const path = greedyWalk(seed, rows, qToks);
    if (!path.length) continue;
    const last = path[path.length - 1]!;
    const bestLast = best[best.length - 1];
    if (path.length > best.length || (path.length === best.length && bestLast != null && factBeats(last, bestLast))) {
      best = path;
    }
  }
  return best;
}

/** Current-graph hop chain for a cue. Last element is the last hop (answer). */
export function hopChain(query: string, rows: HopSource[]): HopFact[] {
  try {
    if (!query || skipGraphText(query) || !Array.isArray(rows) || !rows.length) return [];
    const usable = expandHopRows(rows);
    if (!usable.length) return [];
    const qToks = contentTokens(query);
    const parsed = parseSelfAsk(query);
    let hops: HopFact[] = [];
    if (parsed) {
      hops = walkChain(parsed.seed, parsed.rels, usable, qToks);
      if (hops.length) hops = extendHops(hops, usable, qToks);
    }
    if (!hops.length) hops = bfsHops(query, usable);
    return trimToQuery(hops, query);
  } catch {
    return [];
  }
}

function sameBody(a: string, b: string): boolean {
  return normEnt(bodyOf(a)) === normEnt(bodyOf(b));
}

function findRow<T extends HopSource>(fact: HopFact, rows: T[]): T | undefined {
  let hit = rows.find((r) => r.id && fact.id && r.id === fact.id);
  if (hit) return hit;
  hit = rows.find((r) => sameBody(r.text, fact.text));
  if (hit) return hit;
  const needle = fact.o;
  return rows.find((r) => {
    const t = normEnt(r.text);
    return t.includes(needle) && t.includes(fact.s);
  });
}

function defeatedByHops(text: string, hops: HopFact[]): boolean {
  const trip = extractTriple(text);
  if (!trip) return false;
  return hops.some((h) => h.s === trip.s && h.p === trip.p && h.o !== trip.o);
}

/**
 * Reorder an inject packet so last hop is first among hop results.
 * Missing last-hop rows are unshifted from `store`. Fail-open: throw → notes unchanged.
 * Objects that lost to a newer fact for a chosen hop's (s, p) are dropped.
 */
export function completeNotes<T extends HopSource>(
  query: string,
  notes: T[],
  store: T[] = notes,
  opts?: { pull?: boolean },
): T[] {
  try {
    if (!query || skipGraphText(query)) return notes;
    const hops = hopChain(query, store);
    if (!hops.length) return notes;
    const pull = opts?.pull !== false;
    const hopRows: T[] = [];
    for (let i = hops.length - 1; i >= 0; i--) {
      // Prefer already-labeled/assembled notes. Unlabeled JSONL store is a fallback.
      const fromNotes = findRow(hops[i]!, notes);
      const fromStore = pull && !fromNotes ? findRow(hops[i]!, store) : undefined;
      const rec = fromNotes ?? (fromStore ? ensurePacketLabel(fromStore) : undefined);
      if (!rec) continue;
      if (hopRows.some((r) => r === rec || sameBody(r.text, rec.text) || (r.id && rec.id && r.id === rec.id))) continue;
      hopRows.push(rec);
    }
    if (!hopRows.length) return notes;
    const seen = new Set(hopRows.map((r) => r.id ?? normEnt(r.text)));
    const rest = notes.filter((n) => {
      if (seen.has(n.id ?? normEnt(n.text))) return false;
      return !defeatedByHops(n.text, hops);
    });
    const cap = Math.max(notes.length, hopRows.length);
    return [...hopRows, ...rest].slice(0, cap);
  } catch {
    return notes;
  }
}

/** Boost last hop to top-1 on CLS fused scores. Fail-open: throw → scores unchanged. */
export function completeScores(
  query: string,
  episodes: { i: number; text: string }[],
  scores: Float64Array,
): Float64Array {
  try {
    if (!query || !episodes.length || skipGraphText(query)) return scores;
    const hops = hopChain(
      query,
      episodes.map((e) => ({ text: e.text, i: e.i, at: e.i })),
    );
    if (!hops.length) return scores;
    const out = new Float64Array(scores);
    let mx = 0;
    for (let i = 0; i < out.length; i++) if (out[i]! > mx) mx = out[i]!;
    for (let h = 0; h < hops.length; h++) {
      const ep = hops[h]!.i;
      if (ep < 0 || ep >= out.length) continue;
      out[ep] = mx + 1 + h;
    }
    return out;
  } catch {
    return scores;
  }
}
