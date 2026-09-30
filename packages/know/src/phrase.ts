/** Closed-universe phrase lattice. Hot RFC titles + synth catalog English. Compiled once. */

import { RFC_TITLE_HOT } from "./rfc-hot";
import {
  CAPITAL_OF,
  CHARSET_OBJECT,
  DNS_OBJECT,
  HTTP_REASON,
  SCHEME_OBJECT,
  SPDX_OBJECT,
  UNICODE_BLOCK_OBJECT,
  W3C_OBJECT,
  WELLKNOWN_OBJECT,
  WHATWG_OBJECT,
} from "./synth";

const SIG = 37;
const POISON = new Set([
  "application json",
  "generic syntax",
  "json",
  "uri",
  "url",
  "http",
  "https",
  "get",
  "post",
  "put",
  "patch",
  "head",
  "rfc",
  "html",
  "fetch",
  "dom",
  "file system",
  "test utils",
  "text strings",
  "host information",
  "see other",
  "use proxy",
  "im used",
  "early hints",
  "change password",
]);
const SKIP_REASON = new Set([
  "see other",
  "use proxy",
  "im used",
  "unused",
  "ok",
  "found",
  "created",
  "accepted",
  "continue",
  "gone",
  "locked",
  "processing",
  "early hints",
]);

const EXACT = new Map<string, string>();
const PATS: string[] = [];
const EMIT: string[] = [];
const LEN: number[] = [];

export function foldPhrase(s: string): string {
  let out = "";
  let sp = true;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      if (sp && out.length) out += " ";
      out += String.fromCharCode(c);
      sp = false;
    } else sp = true;
  }
  return out;
}

function alph(c: number): number {
  if (c === 32) return 36;
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 122) return c - 87;
  return -1;
}

function wordCount(f: string): number {
  if (!f.length) return 0;
  let n = 1;
  for (let i = 0; i < f.length; i++) if (f.charCodeAt(i) === 32) n++;
  return n;
}

function put(folded: string, emit: string, minWords: number, minLen: number) {
  if (!folded || !emit) return;
  if (folded.length < minLen || wordCount(folded) < minWords) return;
  if (POISON.has(folded)) return;
  if (EXACT.has(folded)) return;
  EXACT.set(folded, emit);
  PATS.push(folded);
  EMIT.push(emit);
  LEN.push(folded.length);
}

function stripParen(title: string): string {
  let out = "";
  for (let i = 0; i < title.length; i++) {
    const c = title.charCodeAt(i);
    if (c === 40) {
      while (i < title.length && title.charCodeAt(i) !== 41) i++;
      continue;
    }
    out += title[i];
  }
  return out;
}

function addRfc(n: number, title: string) {
  const emit = `RFC ${n}`;
  const full = foldPhrase(title);
  put(full, emit, 2, 10);
  const noParen = foldPhrase(stripParen(title));
  if (noParen !== full) put(noParen, emit, 2, 10);
  const colon = title.indexOf(":");
  if (colon > 0) {
    const right = foldPhrase(title.slice(colon + 1));
    put(right, emit, 3, 18);
  }
  const words = noParen.split(" ");
  let i = 0;
  const w0 = words[0];
  if (w0 === "the" || w0 === "a" || w0 === "an") i = 1;
  if (words.length - i >= 4) {
    const tri = words.slice(i, i + 3).join(" ");
    put(tri, emit, 3, 18);
  }
}

function putTitle(obj: string, emit: string, minWords: number, minLen: number) {
  const f = foldPhrase(obj);
  put(f, emit, minWords, minLen);
  if (f.length > 8 && f.endsWith(" api")) put(f.slice(0, f.length - 4), emit, 2, 8);
}

function addCatalog() {
  for (const [n, title] of Object.entries(RFC_TITLE_HOT)) addRfc(+n, title);

  for (const [slug, obj] of Object.entries(W3C_OBJECT)) {
    putTitle(obj, `W3C ${slug}`, 2, 10);
  }
  for (const [slug, obj] of Object.entries(WHATWG_OBJECT)) {
    putTitle(obj, `WHATWG ${slug}`, 2, 10);
  }
  for (const [id, obj] of Object.entries(SPDX_OBJECT)) {
    put(foldPhrase(obj), id, 2, 10);
  }
  for (const [code, reason] of Object.entries(HTTP_REASON)) {
    const f = foldPhrase(reason);
    if (SKIP_REASON.has(f) || f.includes("unused") || f.includes("obsolet") || f.includes("register")) continue;
    put(f, String(+code), 2, 9);
  }
  for (const [rr, obj] of Object.entries(DNS_OBJECT)) {
    put(foldPhrase(obj), rr, 2, 10);
  }
  for (const [scheme, obj] of Object.entries(SCHEME_OBJECT)) {
    put(foldPhrase(obj), scheme, 3, 16);
  }
  for (const [name, obj] of Object.entries(UNICODE_BLOCK_OBJECT)) {
    put(foldPhrase(name), `Unicode Block ${name}`, 2, 10);
  }
  for (const country of Object.keys(CAPITAL_OF)) {
    put(foldPhrase(country), `capital of ${country}`, 2, 8);
  }
  for (const [country, city] of Object.entries(CAPITAL_OF)) {
    put(foldPhrase(city), `capital of ${country}`, 2, 8);
  }
  for (const [wk, obj] of Object.entries(WELLKNOWN_OBJECT)) {
    put(foldPhrase(obj), `IANA well-known ${wk}`, 2, 12);
  }
  for (const [id, obj] of Object.entries(CHARSET_OBJECT)) {
    const f = foldPhrase(obj);
    if (f === foldPhrase(id)) continue;
    put(f, id === "utf-8" ? "UTF-8" : id, 4, 20);
  }
  put("web idl", "WHATWG webidl", 2, 6);
  put("push api", "W3C push-api", 2, 7);
  put("file api", "W3C fileapi", 2, 7);
  put("url pattern", "WHATWG urlpattern", 2, 10);
  put("websocket connections", "ws", 2, 18);
  put("decentralized identifiers", "W3C did-core", 2, 16);
}

let NEXT: Int16Array;
let FAIL: Int16Array;
let OUT: Int16Array;
let OUTL: Int16Array;
let N = 1;
let ready = false;

function get(s: number, a: number): number {
  return NEXT[s * SIG + a]!;
}
function set(s: number, a: number, v: number) {
  NEXT[s * SIG + a] = v;
}

function alloc(): number {
  const id = N++;
  if (id * SIG + SIG > NEXT.length) {
    const next = new Int16Array(NEXT.length * 2);
    next.fill(-1);
    next.set(NEXT);
    NEXT = next;
    const fail = new Int16Array(FAIL.length * 2);
    fail.set(FAIL);
    FAIL = fail;
    const out = new Int16Array(OUT.length * 2);
    out.fill(-1);
    out.set(OUT);
    OUT = out;
    const outl = new Int16Array(OUTL.length * 2);
    outl.set(OUTL);
    OUTL = outl;
  }
  return id;
}

function compile() {
  addCatalog();
  const guess = Math.max(2048, PATS.length * 12);
  NEXT = new Int16Array(guess * SIG);
  NEXT.fill(-1);
  FAIL = new Int16Array(guess);
  OUT = new Int16Array(guess);
  OUT.fill(-1);
  OUTL = new Int16Array(guess);
  N = 1;
  for (let p = 0; p < PATS.length; p++) {
    const pat = PATS[p]!;
    let s = 0;
    for (let i = 0; i < pat.length; i++) {
      const a = alph(pat.charCodeAt(i));
      if (a < 0) continue;
      let nx = get(s, a);
      if (nx < 0) {
        nx = alloc();
        set(s, a, nx);
      }
      s = nx;
    }
    if (OUT[s]! < 0) OUT[s] = p;
  }
  const q: number[] = [];
  for (let a = 0; a < SIG; a++) {
    const nx = get(0, a);
    if (nx < 0) set(0, a, 0);
    else {
      FAIL[nx] = 0;
      q.push(nx);
    }
  }
  let qi = 0;
  while (qi < q.length) {
    const s = q[qi++]!;
    for (let a = 0; a < SIG; a++) {
      const nx = get(s, a);
      if (nx < 0) {
        set(s, a, get(FAIL[s]!, a));
        continue;
      }
      const f = get(FAIL[s]!, a);
      FAIL[nx] = f;
      OUTL[nx] = OUT[f]! >= 0 ? f : OUTL[f]!;
      q.push(nx);
    }
  }
  ready = true;
}

function ensure() {
  if (!ready) compile();
}

/** Whole-query catalog English → typed needle. Extra tokens stay unmatched. */
export function phraseExact(q: string): string | undefined {
  ensure();
  let f = foldPhrase(q);
  if (!f) return;
  let hit = EXACT.get(f);
  if (hit) return hit;
  if (f.length > 4 && f.charCodeAt(3) === 32 && f.charCodeAt(0) === 116 && f.charCodeAt(1) === 104 && f.charCodeAt(2) === 101) {
    return EXACT.get(f.slice(4));
  }
  if (f.length > 2 && f.charCodeAt(1) === 32 && f.charCodeAt(0) === 97) return EXACT.get(f.slice(2));
  if (f.length > 3 && f.charCodeAt(2) === 32 && f.charCodeAt(0) === 97 && f.charCodeAt(1) === 110) {
    return EXACT.get(f.slice(3));
  }
  return;
}

type PhraseHit = { start: number; end: number; emit: string; pat: string };

function keepLongest(hits: PhraseHit[]): PhraseHit[] {
  const n = hits.length;
  if (n <= 1) return hits;
  const keep = new Uint8Array(n);
  keep.fill(1);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const a = hits[i]!;
    const al = a.end - a.start;
    for (let j = 0; j < n; j++) {
      if (i === j || !keep[j]) continue;
      const b = hits[j]!;
      const bl = b.end - b.start;
      if (a.start >= b.start && a.end <= b.end && al < bl) {
        keep[i] = 0;
        break;
      }
    }
  }
  const out: PhraseHit[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(hits[i]!);
  return out;
}

/** Linear scan. Emits typed needles for catalog phrases in `text`. */
export function scanPhrases(text: string, add: (q: string) => void, cover?: Set<string>) {
  ensure();
  const folded = foldPhrase(text.length > 6_000 ? text.slice(0, 6_000) : text);
  if (folded.length < 9) return;
  let spaced = false;
  for (let i = 0; i < folded.length; i++) {
    if (folded.charCodeAt(i) === 32) {
      spaced = true;
      break;
    }
  }
  if (!spaced) return;
  const hay = ` ${folded} `;
  let s = 0;
  const n = hay.length;
  const hits: PhraseHit[] = [];
  for (let i = 0; i < n; i++) {
    const a = alph(hay.charCodeAt(i));
    if (a < 0) {
      s = 0;
      continue;
    }
    s = get(s, a);
    for (let o = s; o > 0; o = OUTL[o]!) {
      const id = OUT[o]!;
      if (id < 0) continue;
      const len = LEN[id]!;
      const start = i - len + 1;
      if (start < 1) continue;
      if (hay.charCodeAt(start - 1) !== 32) continue;
      if (i + 1 < n && hay.charCodeAt(i + 1) !== 32) continue;
      hits.push({ start, end: i, emit: EMIT[id]!, pat: PATS[id]! });
    }
  }
  const kept = keepLongest(hits);
  for (let i = 0; i < kept.length; i++) {
    const h = kept[i]!;
    add(h.emit);
    if (!cover) continue;
    cover.add(h.emit);
    const pat = h.pat;
    let w = "";
    for (let k = 0; k <= pat.length; k++) {
      const c = k < pat.length ? pat.charCodeAt(k) : 32;
      if (c === 32) {
        if (w.length) cover.add(w);
        w = "";
      } else w += pat[k]!;
    }
  }
}

export function phraseNeedles(text: string): string[] {
  const out: string[] = [];
  scanPhrases(text, (q) => {
    for (let i = 0; i < out.length; i++) if (out[i] === q) return;
    out.push(q);
  });
  return out;
}
