import type { Triple } from "./extract";
import {
  aliasableMediaSubtype,
  catalogSubject,
  ianaCharset,
  ianaDns,
  ianaHeader,
  ianaHttp,
  ianaLanguage,
  ianaMedia,
  ianaMethod,
  ianaProtocol,
  ianaRel,
  ianaScheme,
  ianaWellKnown,
  spdxAliasable,
  spdxId,
  unicodeBlock,
  unicodeScript,
  whatwgSlug,
} from "./names";

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

export const STOP_POST = new Set(
  "the and for that this with from are was were been have has had but not you all can her his they them than then into more some such only other after first also just like well even most many those come made find long down did get own see way may say she use two how its our out about would could should which there their being under over".split(
    " ",
  ),
);

export function postTokens(s: string): string[] {
  return tokens(s).filter((t) => !STOP_POST.has(t));
}

/** Query tokens keep short identifiers (`GET`, `en`) that `postTokens` would drop as stop/short. */
export function queryTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9+.-]+/)
    .filter((t) => t.length > 1)
    .filter((t) => t.length <= 3 || !STOP_POST.has(t));
}

/** Catalog subjects: subject + alias tokens only. Object titles poison AND rank. */
export function indexTokens(t: Triple): string[] {
  if (/^RFC\s+\d/i.test(t.s) && (t.p === "is" || t.p === "obsoletes" || t.p === "updates")) {
    const num = t.s.match(/\d+/)?.[0] ?? "";
    const head = t.o.split(/\s+/).slice(0, 5).join(" ");
    return postTokens(`rfc ${num} ${t.p} ${head}`);
  }
  if (/^W3C\s+/i.test(t.s) && t.p === "is") {
    const slug = t.s.replace(/^W3C\s+/i, "");
    return postTokens(`w3c ${slug}`);
  }
  const proto = ianaProtocol(t.s);
  if (proto !== undefined && t.p === "is") return postTokens(`iana protocol ${t.o}`);
  const http = ianaHttp(t.s);
  if (http !== undefined && t.p === "is") return postTokens(`iana http ${http}`);
  const media = ianaMedia(t.s);
  if (media && t.p === "is") return postTokens(`iana media ${media}`);
  const scheme = ianaScheme(t.s);
  if (scheme && t.p === "is") return postTokens(`iana scheme ${scheme}`);
  const spdx = spdxId(t.s);
  if (spdx && t.p === "is") return postTokens(`spdx ${spdx}`);
  const whatwg = whatwgSlug(t.s);
  if (whatwg && t.p === "is") return postTokens(`whatwg ${whatwg}`);
  const block = unicodeBlock(t.s);
  if (block && t.p === "is") return postTokens(`unicode block ${block}`);
  const lang = ianaLanguage(t.s);
  if (lang && t.p === "is") return postTokens(`iana language ${lang} ${t.o}`);
  const method = ianaMethod(t.s);
  if (method && t.p === "is") return postTokens(`iana method ${method}`);
  const rel = ianaRel(t.s);
  if (rel && t.p === "is") return postTokens(`iana rel ${rel}`);
  const wk = ianaWellKnown(t.s);
  if (wk && t.p === "is") return postTokens(`iana well-known ${wk}`);
  const script = unicodeScript(t.s);
  if (script && t.p === "is") return postTokens(`unicode script ${script} ${t.o}`);
  const charset = ianaCharset(t.s);
  if (charset && t.p === "is") return postTokens(`iana charset ${charset}`);
  const header = ianaHeader(t.s);
  if (header && t.p === "is") return postTokens(`iana header ${header}`);
  const dns = ianaDns(t.s);
  if (dns && t.p === "is") return postTokens(`iana dns ${dns}`);
  return postTokens(`${t.s} ${t.p} ${t.o}`);
}

function aliasLex(raw: string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    for (const p of r.toLowerCase().split(/[^a-z0-9+.-]+/)) {
      if (p.length > 1) out.push(p);
    }
  }
  return [...new Set(out)];
}

/** Lean WAL postings for catalog rows. Matches pack aliases; does not index every media subtype. */
export function catalogAliasKeys(t: Triple): string[] {
  if (!catalogSubject(t.s) || (t.p !== "is" && t.p !== "obsoletes" && t.p !== "updates")) return [];
  const keys: string[] = [];
  if (/^RFC\s+\d/i.test(t.s)) {
    const num = t.s.match(/\d+/)?.[0];
    if (num) keys.push(num, `rfc${num}`);
    keys.push(...t.o.split(/\s+/).slice(0, 5));
    return aliasLex(keys);
  }
  if (/^W3C\s+/i.test(t.s) && t.p === "is") {
    keys.push(t.s.replace(/^W3C\s+/i, ""));
    return aliasLex(keys);
  }
  const proto = ianaProtocol(t.s);
  if (proto !== undefined && t.p === "is") return aliasLex([t.o]);
  const http = ianaHttp(t.s);
  if (http !== undefined && t.p === "is") return aliasLex([String(http)]);
  const media = ianaMedia(t.s);
  if (media && t.p === "is") {
    const sub = media.split("/")[1] || "";
    if (aliasableMediaSubtype(sub)) return aliasLex([sub, media]);
    return [];
  }
  const scheme = ianaScheme(t.s);
  if (scheme && t.p === "is") return aliasLex([scheme]);
  const spdx = spdxId(t.s);
  if (spdx && t.p === "is") return spdxAliasable(spdx) ? aliasLex([spdx]) : [];
  const whatwg = whatwgSlug(t.s);
  if (whatwg && t.p === "is") return aliasLex([whatwg]);
  const block = unicodeBlock(t.s);
  if (block && t.p === "is") return aliasLex([block]);
  const lang = ianaLanguage(t.s);
  if (lang && t.p === "is") return aliasLex([lang, t.o]);
  const method = ianaMethod(t.s);
  if (method && t.p === "is") return aliasLex([method]);
  const rel = ianaRel(t.s);
  if (rel && t.p === "is") return aliasLex([rel]);
  const wk = ianaWellKnown(t.s);
  if (wk && t.p === "is") return aliasLex([wk]);
  const script = unicodeScript(t.s);
  if (script && t.p === "is") return aliasLex([script, t.o]);
  const charset = ianaCharset(t.s);
  if (charset && t.p === "is") return aliasLex([charset]);
  const header = ianaHeader(t.s);
  if (header && t.p === "is") return aliasLex([header]);
  const dns = ianaDns(t.s);
  if (dns && t.p === "is") return aliasLex([dns]);
  return [];
}
