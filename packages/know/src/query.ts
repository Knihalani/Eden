import { bareMediaType, ianaMedia, MEDIA_SUBTYPE_OBJECT, aliasableMediaSubtype } from "./names";
import { rfcTitleHot } from "./rfc-hot";
import {
  HTTP_REASON,
  PROTO_NAME,
  SCHEME_OBJECT,
  SPDX_OBJECT,
  LANG_OBJECT,
  SCRIPT_OBJECT,
  WHATWG_OBJECT,
  W3C_OBJECT,
  WELLKNOWN_OBJECT,
  CHARSET_OBJECT,
  METHOD_OBJECT,
  CAPITAL_OF,
  UNICODE_BLOCK_OBJECT,
} from "./synth";
import { HEADER_SET, METHOD_SET, PROTO_SET, SCHEME_SET, DNS_SET, techniqueQueryFallbacks } from "./needles";
import { phraseExact } from "./phrase";

const STOP = new Set(["the", "of", "is", "a", "an", "on", "to", "and", "in"]);
/** Same 16 IETF area labels as pack RFC_AREAS. Inlined so flash never loads pack.ts. */
const AREA_SET = new Set<string>([
  "HTTP",
  "mail",
  "DNS",
  "routing",
  "security",
  "media",
  "transport",
  "IP",
  "URI",
  "realtime",
  "ops",
  "time",
  "file",
  "directory",
  "charset",
  "Internet",
]);
/** Glue for implementer cards. Not STOP — extra query tokens like “AAAA record” stay unknown. */
const CARD_GLUE = new Set(["record", "type", "scheme", "uri", "link", "relation"]);
/** Filler in technique queries; pack AND still saw them, card grounding should not require them. */
const TECH_OPTIONAL = new Set(["command", "line", "cli", "tool", "using", "with", "from", "into", "this", "that", "nested", "output", "records", "services", "without", "compile", "step", "please", "just"]);
const MAX_TOKENS = 48;
const ENTITY = /&(?:#x?[0-9a-f]+|[a-z]+);/i;
const URLISH = /https?:\/\//i;

/** English countries that take a definite article: the United Kingdom, the Netherlands, … */
const THE_COUNTRY = new Set(
  [
    "united kingdom",
    "united states",
    "united states of america",
    "united arab emirates",
    "netherlands",
    "philippines",
    "czech republic",
    "dominican republic",
    "democratic republic of the congo",
    "ivory coast",
    "bahamas",
    "gambia",
    "maldives",
    "seychelles",
    "comoros",
    "solomon islands",
    "marshall islands",
    "central african republic",
  ],
);

type Hit = { s: string; p: string; o: string; e: string; url?: string };
type KnowSearch = {
  search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[];
  close?: () => void;
};

export type FactCard = { fact: string; confidence: number; url?: string };

/** Public page a card can name. Empty / relative / javascript stay off the cite. */
export function citeableUrl(raw?: string): string | undefined {
  const u = (raw || "").trim();
  if (u.length < 12 || u.length > 240) return;
  if (!/^https?:\/\//i.test(u)) return;
  if (/[\s<>"'\\]/.test(u)) return;
  try {
    const p = new URL(u);
    if (p.protocol !== "http:" && p.protocol !== "https:") return;
    if (!p.hostname.includes(".")) return;
    return u;
  } catch {
    return;
  }
}

function rfcPageUrl(s: string): string | undefined {
  const m = /^RFC\s+(\d{1,5})$/i.exec(s.trim());
  if (!m) return;
  return `https://www.rfc-editor.org/rfc/rfc${Number(m[1])}.html`;
}

function sourceOf(raw: Hit, s: string): string | undefined {
  return citeableUrl(raw.url) || rfcPageUrl(s);
}

let extractMod: typeof import("./extract") | undefined;
function extract() {
  return extractMod ?? (extractMod = require("./extract") as typeof import("./extract"));
}

function toks(s: string): string[] {
  let expanded = s;
  if (s.length < 96 && (s.includes("rfc") || s.includes("RFC") || s.includes("w3c") || s.includes("W3C") || /utf8/i.test(s))) {
    expanded = s
      .replace(/\b(rfc)(\d{1,5})\b/gi, "$1 $2")
      .replace(/\b(w3c)([a-z0-9-]+)/gi, "$1 $2")
      .replace(/\butf8\b/gi, "utf-8");
  }
  const parts = expanded
    .toLowerCase()
    .split(/[^a-z0-9+.-]+/)
    .filter((t) => t.length > 1);
  if (!expanded.includes("-")) return parts;
  const out: string[] = [];
  for (const p of parts) {
    out.push(p);
    if (p.includes("-")) {
      for (const bit of p.split("-")) if (bit.length > 1) out.push(bit);
    }
  }
  return out;
}

/** Whole-query forms that name a packed row. Extra tokens stay as-is (unknown). */
function rewriteQuery(q: string): string {
  const t = q.trim();
  if (!t) return t;
  const sax = /^(.+?)['\u2019]s capital$/i.exec(t);
  if (sax) {
    const name = sax[1]!.replace(/\s+/g, " ").trim().replace(/^(the|a)\s+/i, "");
    if (name.length >= 2) return `capital of ${name}`;
  }
  if (t.includes("=")) {
    const cs = /^charset\s*=\s*["']?([a-z0-9][a-z0-9._:+-]{1,40})["']?$/i.exec(t);
    if (cs) {
      const v = cs[1]!;
      return /^utf8$/i.test(v) ? "utf-8" : v;
    }
  }
  if (t.length <= 5 && /^utf8$/i.test(t)) return "utf-8";
  if (t.includes("SPDX") || t.includes("spdx")) {
    const spdx = /^SPDX-License-Identifier\s*:\s*([A-Za-z0-9.+-]+)$/i.exec(t);
    if (spdx) return spdx[1]!;
  }
  if (t.includes("well-known")) {
    const wk = /(?:^|\/)\.well-known\/([a-z0-9][a-z0-9._-]{1,48})$/i.exec(t);
    if (wk) return `IANA well-known ${wk[1]!.toLowerCase()}`;
  }
  if (t.includes("://")) {
    const uri = /^(https?|wss?|ftp|file|git|ssh|sftp):\/\/\S+$/i.exec(t);
    if (uri) return uri[1]!.toLowerCase();
  }
  const used = /^what(?:'s| is)\s+([A-Za-z][\w.+-]{1,40})\s+used for\??$/i.exec(t);
  return phraseExact(t) || (used ? `used for ${used[1]!.toLowerCase()}` : t);
}

function capTokens(s: string, n = MAX_TOKENS): string {
  const parts = extract()
    .decodeEntities(s)
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/);
  if (parts.length <= n) return parts.join(" ");
  return parts.slice(0, n).join(" ");
}

function mediaWant(q: string): string | undefined {
  const direct = ianaMedia(q) || bareMediaType(q);
  if (direct) return direct;
  const t = q.trim();
  if (t.length === 4) {
    const a = t.charCodeAt(0) | 32;
    const b = t.charCodeAt(1) | 32;
    const c = t.charCodeAt(2) | 32;
    const d = t.charCodeAt(3) | 32;
    if (a === 106 && b === 115 && c === 111 && d === 110) return "application/json";
  }
  return undefined;
}

function rfcTitle(o: string, e: string): string {
  const { shortTitle } = extract();
  const clean = (s: string) => shortTitle(s.replace(/^RFC\s*\d+\s*[:\-–]\s*/i, ""));
  const a = clean(o);
  const b = clean(e);
  const uri = (s: string) => /\(URI\)/i.test(s);
  if (uri(a) && !uri(b)) return a;
  if (uri(b) && !uri(a)) return b;
  const wa = a.split(/\s+/).filter(Boolean).length;
  const wb = b.split(/\s+/).filter(Boolean).length;
  return wb > wa ? b : a;
}

function tautology(a: string, b: string): boolean {
  const aa = toks(a).filter((t) => !STOP.has(t));
  const bb = toks(b).join(" ");
  return aa.length > 0 && aa.every((t) => bb.includes(t));
}

function articleFor(word: string): "a" | "an" {
  const w = word.trim();
  if (/^(html|http|xml|svg|spdx|ip[46]?|iana)\b/i.test(w) || /^[aeiou]/i.test(w)) return "an";
  return "a";
}

function countryForCard(s: string): string {
  const country = s.replace(/^the\s+/i, "").replace(/\s+/g, " ").trim();
  return THE_COUNTRY.has(country.toLowerCase()) ? `the ${country}` : country;
}

function rankHits(q: string, hits: Hit[]): Hit[] {
  const mediaQ = mediaWant(q);
  let list = mediaQ
    ? hits.filter((h) => {
        const m = ianaMedia(h.s) || "";
        return m === mediaQ || (mediaQ === "application/json" && m.endsWith("/json"));
      })
    : hits.slice();
  if (mediaQ && !list.length) return [];
  const ql = q.trim().toLowerCase();
  const wantObs = /\bobsolet/.test(ql);
  const wantUpd = /\bupdates\b/.test(ql) || /\bupdated by\b/.test(ql);
  const techniqueQ = ql.startsWith("used for ");
  const techRest = techniqueQ ? toks(ql.slice(9)) : [];
  const score = (h: Hit): number => {
    const sl = h.s.toLowerCase();
    if (wantObs && (h.p === "obsoletes" || (h.p === "is" && /obsoleted by/i.test(h.o)))) return -1;
    if (wantUpd && (h.p === "updates" || (h.p === "is" && /updated by/i.test(h.o)))) return -1;
    if (techniqueQ && h.p === "is" && h.o.toLowerCase().startsWith("used for")) {
      const ot = toks(h.o);
      let n = 0;
      for (const t of techRest) {
        if (ot.includes(t)) n++;
        else if (t.length >= 4 && ot.some((b) => b.startsWith(t) && b.length - t.length > 0 && b.length - t.length <= 4)) n++;
      }
      return -8 - n - Math.min(h.o.length, 80) / 80;
    }
    if (mediaQ && (ianaMedia(h.s) || "") === mediaQ) return 0;
    if (sl === ql) return h.p === "is" ? 0 : 0.4;
    if (sl === `iana method ${ql}` || sl === `iana http ${ql}` || sl === `iana header ${ql}`) return 0;
    if (sl === `iana charset ${ql}` || sl === `iana scheme ${ql}` || sl === `spdx ${ql}`) return 0;
    if (/^utf-?8$/i.test(ql) && sl === "iana charset utf-8") return 0;
    if (sl === `iana dns ${ql}` || sl === `iana well-known ${ql}`) return 0;
    if (sl === `rfc ${ql.replace(/^rfc\s+/, "")}`) return h.p === "is" ? 0 : 0.4;
    if (h.p === "capital") return 1;
    if (h.p === "is") return 2;
    return 3;
  };
  return list.sort((a, b) => score(a) - score(b));
}

function cardFromHit(
  q: string,
  raw: Hit,
): FactCard | undefined {
  const { looksLikeCode, decodeEntities } = extract();
  const n = {
    s: decodeEntities(raw.s),
    p: raw.p,
    o: decodeEntities(raw.o),
    e: decodeEntities(raw.e),
  };
  if (n.p === "about" || n.p === "date") return undefined;
  if (n.p !== "capital" && n.p !== "is" && n.p !== "obsoletes" && n.p !== "updates" && looksLikeCode(`${n.o} ${n.e}`)) {
    return undefined;
  }
  let fact = "";
  if (n.p === "capital") {
    fact = `The capital of ${countryForCard(n.s)} is ${n.o}.`;
  }
  else if (/^RFC\s+\d/i.test(n.s) && n.p === "is") {
    if (/^(?:obsoleted|updated) by RFC\s+\d/i.test(n.o)) fact = `${n.s} is ${n.o}.`;
    else {
      const title = rfcTitle(n.o, n.e);
      if (AREA_SET.has(title)) fact = `${n.s} is ${articleFor(title)} ${title} RFC.`;
      else fact = `${n.s} is ${title}.`;
    }
  }
  else if (/^W3C\s+/i.test(n.s) && n.p === "is") fact = `${n.s} is ${n.o}.`;
  else if (/^IANA\s+media\s+/i.test(n.s) && n.p === "is") {
    const media = n.s.replace(/^IANA\s+media\s+/i, "");
    fact = `${media} is ${articleFor(n.o)} ${n.o} media type.`;
  } else if (/^SPDX\s+/i.test(n.s) && n.p === "is") {
    const id = n.s.replace(/^SPDX\s+/i, "");
    fact =
      tautology(n.o, `${id} license`) || tautology(n.o, id) ? `${id} is an SPDX license.` : `${id} is ${n.o}.`;
  } else if (/^IANA\s+method\s+/i.test(n.s) && n.p === "is") {
    fact = `${n.s.replace(/^IANA\s+method\s+/i, "")} is ${n.o}.`;
  } else if (/^IANA\s+http\s+/i.test(n.s) && n.p === "is") {
    fact = `HTTP ${n.s.replace(/^IANA\s+http\s+/i, "")} is ${n.o}.`;
  } else if (/^IANA\s+protocol\s+/i.test(n.s) && n.p === "is") {
    fact = `${n.o} is protocol ${n.s.replace(/^IANA\s+protocol\s+/i, "")}.`;
  } else if (/^IANA\s+scheme\s+/i.test(n.s) && n.p === "is") {
    const sch = n.s.replace(/^IANA\s+scheme\s+/i, "");
    fact = n.o.trim().toLowerCase() === sch.toLowerCase() ? `${sch} is a URI scheme.` : `${sch} is ${n.o}.`;
  } else if (/^IANA\s+rel\s+/i.test(n.s) && n.p === "is") {
    const rel = n.s.replace(/^IANA\s+rel\s+/i, "");
    fact = n.o.trim().toLowerCase() === rel.toLowerCase() ? `${rel} is a link relation.` : `${rel} is ${n.o}.`;
  } else if (/^IANA\s+charset\s+/i.test(n.s) && n.p === "is") {
    const cs = n.s.replace(/^IANA\s+charset\s+/i, "");
    const shown = /^utf-8$/i.test(cs) ? "UTF-8" : cs;
    fact = tautology(n.o, cs) ? `${shown} is a charset.` : `${shown} is ${n.o}.`;
  } else if (/^IANA\s+header\s+/i.test(n.s) && n.p === "is") {
    const h = n.s.replace(/^IANA\s+header\s+/i, "");
    fact = tautology(n.o, `${h} http field header`) ? `${h} is an HTTP header.` : `${h} is ${n.o}.`;
  } else if (/^IANA\s+dns\s+/i.test(n.s) && n.p === "is") {
    const rr = n.s.replace(/^IANA\s+dns\s+/i, "");
    fact = `${rr} is ${articleFor(n.o)} ${n.o} record.`;
  } else if (/^IANA\s+well-known\s+/i.test(n.s) && n.p === "is") {
    const wk = n.s.replace(/^IANA\s+well-known\s+/i, "");
    fact = n.o.trim().toLowerCase() === wk.toLowerCase() ? `${wk} is a well-known URI.` : `${wk} is ${n.o}.`;
  } else if (/^(IANA|WHATWG|Unicode)\s+/i.test(n.s) && n.p === "is") fact = `${n.s} is ${n.o}.`;
  else if (n.p === "obsoletes") fact = `${n.s} obsoletes ${n.o}.`;
  else if (n.p === "updates") fact = `${n.s} updates ${n.o}.`;
  else if (n.p === "is") fact = `${n.s} is ${n.o}.`;
  else fact = capTokens(`${n.s} ${n.p} ${n.o}`, 32);
  if (fact.endsWith("..")) fact = fact.slice(0, -1);
  fact = capTokens(fact, MAX_TOKENS);
  if (!fact.trim() || ENTITY.test(fact) || URLISH.test(fact)) return undefined;
  const blob = `${n.s} ${n.p} ${n.o} ${n.e}`.toLowerCase();
  const blobToks = new Set(toks(blob));
  const techniqueQ = q.trim().toLowerCase().startsWith("used for ");
  const qtoks = toks(q).filter((t) => !STOP.has(t) && !(techniqueQ && TECH_OPTIONAL.has(t)));
  const queryHit =
    !qtoks.length ||
    qtoks.every(
      (t) =>
        blobToks.has(t) ||
        (techniqueQ &&
          t.length >= 4 &&
          [...blobToks].some((b) => b.startsWith(t) && b.length - t.length > 0 && b.length - t.length <= 4)),
    );
  const grounded = toks(fact)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 1)
    .every((t) => STOP.has(t) || CARD_GLUE.has(t) || blobToks.has(t) || blob.includes(t));
  if (!grounded || !queryHit) return undefined;
  const typed = n.p === "capital" || n.p === "is" || n.p === "obsoletes" || n.p === "updates";
  const url = sourceOf(raw, n.s);
  return url ? { fact, confidence: typed ? 0.6 : 0.5, url } : { fact, confidence: typed ? 0.6 : 0.5 };
}

export function formatCard(q: string, hits: Hit[]): FactCard | { unknown: true } {
  if (!q.trim()) return { unknown: true };
  for (const raw of rankHits(q, hits)) {
    const card = cardFromHit(q, raw);
    if (card) return card;
  }
  return { unknown: true };
}

const CONF = 0.6;

/** Closed-universe intern. Kenya / JSON / 404 / hot RFC never touch rfc-titles.bin. */
const INTERN = new Map<string, FactCard>();
const RFC_INTERN = new Map<number, FactCard>();
const SPDX_LC = new Map<string, string>();
const PROTO_BY_NAME = new Map<string, string>();
const BLOCK_LC = new Map<string, string>();
const DNS_OBJECT: Record<string, string> = {
  A: "Host Address",
  AAAA: "IP6 Address",
  HTTPS: "HTTPS",
  MX: "Mail Exchange",
  TXT: "Text",
  NS: "Name Server",
  SOA: "Start of Authority",
  PTR: "Pointer",
  SRV: "Service Location",
  CAA: "Certification Authority Authorization",
  CNAME: "Canonical Name",
  NAPTR: "Naming Authority Pointer",
  DNSKEY: "DNSKEY",
  RRSIG: "RRSIG",
  NSEC3PARAM: "NSEC3PARAM",
  NSEC3: "NSEC3",
  TLSA: "TLSA",
  SVCB: "Service Binding",
  SSHFP: "SSH Fingerprint",
  SMIMEA: "S/MIME Association",
  CDNSKEY: "CDNSKEY",
  OPENPGPKEY: "OpenPGP Key",
  HINFO: "Host Information",
  DNAME: "DNAME",
  AFSDB: "AFS Data Base location",
  SPF: "Sender Policy Framework",
};

let flashReady = false;
const CAPITAL_NAME = new Map<string, string>();
function ensureFlash() {
  if (flashReady) return;
  flashReady = true;
  for (const [id] of Object.entries(SPDX_OBJECT)) SPDX_LC.set(id.toLowerCase(), id);
  for (const [num, name] of Object.entries(PROTO_NAME)) PROTO_BY_NAME.set(name.toUpperCase(), num);
}

function canonCountry(name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(CAPITAL_OF, name)) return name;
  if (!CAPITAL_NAME.size) {
    for (const country of Object.keys(CAPITAL_OF)) {
      const k = country.toLowerCase();
      if (!CAPITAL_NAME.has(k)) CAPITAL_NAME.set(k, country);
    }
  }
  return CAPITAL_NAME.get(name.toLowerCase());
}

function internFact(key: string, fact: string): FactCard {
  let c = INTERN.get(key);
  if (c) return c;
  const k = key.toLowerCase();
  if (k !== key) {
    c = INTERN.get(k);
    if (c) {
      INTERN.set(key, c);
      return c;
    }
  }
  c = Object.freeze({ fact, confidence: CONF });
  INTERN.set(key, c);
  if (k !== key) INTERN.set(k, c);
  return c;
}

function keep(t: string, c: FactCard | undefined): FactCard | undefined {
  if (c) INTERN.set(t, c);
  return c;
}

const HOT_TECH: Record<string, string> = {
  jq: "jq is used for filtering JSON on the command line.",
  ripgrep: "ripgrep is used for searching code quickly.",
  bun: "Bun is used for running TypeScript services.",
};

export function flashCard(q: string): FactCard | undefined {
  if (!q.trim()) return;
  return buildTyped(rewriteQuery(q));
}

function buildTyped(t: string): FactCard | undefined {
  const n = t.length;
  if (n < 2 || n > 80) return;
  const cached = INTERN.get(t);
  if (cached) return cached;

  if (n >= 9 && t.slice(0, 9).toLowerCase() === "used for ") {
    const fact = HOT_TECH[t.slice(9).trim().toLowerCase()];
    if (fact) return keep(t, internFact(t.toLowerCase(), fact));
  }

  if (n >= 7 && n <= 10 && (t.startsWith("RFC ") || t.startsWith("rfc "))) {
    const rest = t.slice(4);
    if (rest.length >= 3 && rest.length <= 5 && rest === String(+rest)) {
      const num = +rest;
      const hit = RFC_INTERN.get(num);
      if (hit) {
        INTERN.set(t, hit);
        return hit;
      }
      const title = rfcTitleHot(num);
      if (!title) return;
      const card = Object.freeze({ fact: `RFC ${num} is ${title}.`, confidence: CONF });
      RFC_INTERN.set(num, card);
      INTERN.set(t, card);
      return card;
    }
    return;
  }

  if (n >= 12 && t.slice(0, 11).toLowerCase() === "capital of ") {
    const country = canonCountry(t.slice(11).trim());
    if (!country) return;
    const city = CAPITAL_OF[country];
    if (!city) return;
    return keep(t, internFact(`capital of ${country}`, `The capital of ${countryForCard(country)} is ${city}.`));
  }

  if (n === 3 && t >= "100" && t <= "599" && t === String(+t)) {
    const reason = HTTP_REASON[+t];
    if (!reason) return;
    return keep(t, internFact(t, `HTTP ${t} is ${reason}.`));
  }
  if (n >= 7 && n <= 8 && /^HTTP\s*[1-5]\d{2}$/i.test(t)) {
    const code = t.replace(/\D/g, "");
    const reason = HTTP_REASON[+code];
    if (!reason) return;
    return keep(t, internFact(code, `HTTP ${code} is ${reason}.`));
  }

  const media = mediaWant(t);
  if (media) {
    const sub = media.split("/")[1] || "";
    if (!aliasableMediaSubtype(sub)) return;
    const obj = MEDIA_SUBTYPE_OBJECT[sub.toLowerCase()] || sub;
    return keep(t, internFact(t, `${media} is ${articleFor(obj)} ${obj} media type.`));
  }

  const up = t.toUpperCase();
  if (METHOD_SET.has(up) && n <= 7) {
    const obj = METHOD_OBJECT[up];
    if (!obj) return;
    return keep(t, internFact(up, `${up} is ${obj}.`));
  }
  if (HEADER_SET.has(t)) {
    return keep(t, internFact(t, `${t} is an HTTP header.`));
  }
  const spdx = SPDX_OBJECT[t] ? t : (ensureFlash(), SPDX_LC.get(t.toLowerCase()));
  if (spdx) {
    return keep(t, internFact(spdx, `${spdx} is an SPDX license.`));
  }

  const csKey = t.toLowerCase() === "utf8" ? "utf-8" : t.toLowerCase();
  if (csKey === "utf-8" || Object.prototype.hasOwnProperty.call(CHARSET_OBJECT, csKey)) {
    const shown = csKey === "utf-8" ? "UTF-8" : t;
    const obj = CHARSET_OBJECT[csKey] || shown;
    const fact = tautology(obj, csKey) || obj.toLowerCase() === csKey || shown === obj ? `${shown} is a charset.` : `${shown} is ${obj}.`;
    return keep(t, internFact(csKey, fact));
  }

  if (PROTO_SET.has(up)) {
    ensureFlash();
    const num = PROTO_BY_NAME.get(up);
    if (num === undefined) return;
    return keep(t, internFact(up, `${up} is protocol ${num}.`));
  }
  const scheme = t.toLowerCase();
  if (SCHEME_SET.has(scheme) && Object.prototype.hasOwnProperty.call(SCHEME_OBJECT, scheme)) {
    return keep(t, internFact(scheme, `${scheme} is ${SCHEME_OBJECT[scheme]}.`));
  }

  if (n >= 9 && t.slice(0, 9).toLowerCase() === "iana dns ") {
    const rr = t.slice(9).trim().toUpperCase();
    const obj = DNS_OBJECT[rr];
    if (!obj) return;
    return keep(t, internFact(`iana dns ${rr}`, `${rr} is ${articleFor(obj)} ${obj} record.`));
  }
  if (DNS_SET.has(up) && DNS_OBJECT[up]) {
    const obj = DNS_OBJECT[up]!;
    return keep(t, internFact(up, `${up} is ${articleFor(obj)} ${obj} record.`));
  }

  if (n >= 4 && t.slice(0, 4).toLowerCase() === "w3c ") {
    const slug = t.slice(4).trim().toLowerCase();
    const obj = W3C_OBJECT[slug];
    if (!obj) return;
    return keep(t, internFact(`w3c ${slug}`, `W3C ${slug} is ${obj}.`));
  }
  if (n >= 7 && t.slice(0, 7).toLowerCase() === "whatwg ") {
    const slug = t.slice(7).trim().toLowerCase();
    const obj = WHATWG_OBJECT[slug];
    if (!obj) return;
    return keep(t, internFact(`whatwg ${slug}`, `WHATWG ${slug} is ${obj}.`));
  }
  if (n >= 15 && t.slice(0, 14).toLowerCase() === "unicode block ") {
    const raw = t.slice(14).trim();
    if (!BLOCK_LC.size) {
      for (const name of Object.keys(UNICODE_BLOCK_OBJECT)) BLOCK_LC.set(name.toLowerCase(), name);
    }
    const name = Object.prototype.hasOwnProperty.call(UNICODE_BLOCK_OBJECT, raw) ? raw : BLOCK_LC.get(raw.toLowerCase());
    if (!name) return;
    const obj = UNICODE_BLOCK_OBJECT[name];
    if (!obj) return;
    return keep(t, internFact(`unicode block ${name}`, `Unicode Block ${name} is ${obj}.`));
  }
  if (n >= 15 && t.slice(0, 14).toLowerCase() === "iana language ") {
    const tag = t.slice(14).trim().toLowerCase();
    const obj = LANG_OBJECT[tag];
    if (!obj) return;
    return keep(t, internFact(`iana language ${tag}`, `IANA language ${tag} is ${obj}.`));
  }
  if (n >= 16 && t.slice(0, 16).toLowerCase() === "iana well-known ") {
    const wk = t.slice(16).trim().toLowerCase();
    const obj = WELLKNOWN_OBJECT[wk];
    if (!obj) return;
    return keep(t, internFact(`iana well-known ${wk}`, `${wk} is ${obj}.`));
  }
  if (n === 4 && SCRIPT_OBJECT[t]) {
    return keep(t, internFact(t, `Unicode Script ${t} is ${SCRIPT_OBJECT[t]}.`));
  }
  return;
}

let packCache: typeof import("./cache") | undefined;
function sharedStore(): KnowSearch {
  return (packCache ?? (packCache = require("./cache") as typeof import("./cache"))).sharedStore();
}

export function knowQuery(q: string, store?: KnowSearch) {
  if (!q.trim()) return { unknown: true };
  const nq = rewriteQuery(q);
  const flash = buildTyped(nq);
  if (flash) return flash;
  const s = store ?? sharedStore();
  const searchHits = (query: string) => {
    let hits = s.search(query, 8).filter((h) => h.p !== "about" && h.p !== "date");
    if (/\b(obsoletes|obsoleted|updates|updated)\b/i.test(query)) {
      const want = /\bupdates?\b/i.test(query) && !/\bobsolet/i.test(query) ? "updates" : "obsoletes";
      const edge = hits.find((h) => h.p === want) || hits.find((h) => h.p === "is" && /obsoleted by|updated by/i.test(h.o));
      if (edge) hits = [edge, ...hits.filter((h) => h !== edge)];
    }
    return hits;
  };
  let query = nq;
  let hits = searchHits(query);
  if (!hits.length && /^used for /i.test(nq)) {
    for (const alt of techniqueQueryFallbacks(nq)) {
      hits = searchHits(alt);
      if (hits.length) {
        query = alt;
        break;
      }
    }
  }
  return formatCard(query, hits);
}

export { MAX_TOKENS };
