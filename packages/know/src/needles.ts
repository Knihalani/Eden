import { aliasableMediaSubtype, SPDX_KEEP } from "./names";
import { scanPhrases } from "./phrase";
import { CAPITAL_OF } from "./synth";
import { firstRfcNeedle } from "./rfc-needle";

export { firstRfcNeedle };

const HEADER_SET = new Set(
  "Accept Accept-Encoding Accept-Language Authorization Cache-Control Content-Type Cookie ETag Host If-None-Match If-Modified-Since Location Origin Referer User-Agent WWW-Authenticate X-Request-Id".split(
    " ",
  ),
);
const METHOD_SET = new Set("GET POST PUT PATCH DELETE HEAD OPTIONS CONNECT TRACE".split(" "));
const PROTO_SET = new Set("TCP UDP ICMP SCTP GRE".split(" "));
const SCHEME_SET = new Set("http https mailto ws wss ftp file blob git ssh urn sftp ldap ldaps".split(" "));
const DNS_BARE = new Set(
  "AAAA CNAME NAPTR DNSKEY RRSIG NSEC3PARAM NSEC3 TLSA SVCB SSHFP SMIMEA CDNSKEY OPENPGPKEY HINFO DNAME AFSDB".split(
    " ",
  ),
);
const DNS_SET = new Set([
  ...DNS_BARE,
  ..."MX TXT NS SOA PTR SRV CAA SPF".split(" "),
]);
export { HEADER_SET, METHOD_SET, PROTO_SET, SCHEME_SET, DNS_SET, DNS_BARE };

const SPDX_LC = new Map([...SPDX_KEEP].map((id) => [id.toLowerCase(), id]));
const CHARSET_EMIT = new Map<string, string>();
const CAPITAL_LC = new Map<string, string>();
function countryOf(name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(CAPITAL_OF, name)) return name;
  if (!CAPITAL_LC.size) {
    for (const c of Object.keys(CAPITAL_OF)) {
      const k = c.toLowerCase();
      if (!CAPITAL_LC.has(k)) CAPITAL_LC.set(k, c);
    }
  }
  return CAPITAL_LC.get(name.toLowerCase());
}

type DictKind =
  | "header"
  | "method"
  | "proto"
  | "scheme"
  | "dns"
  | "dnsCtx"
  | "spdx"
  | "charset"
  | "rfcLead"
  | "httpLead"
  | "w3cLead"
  | "whatwgLead"
  | "statusLead"
  | "spdxHdr"
  | "unicodeLead"
  | "scriptLead"
  | "ianaLead"
  | "capitalLead"
  | "dnsLead"
  | "jsonWord"
  | "mediaWord"
  | "licenseWord"
  | "recordWord"
  | "schemeCue";
const TOKEN_MAP = new Map<string, { kind: DictKind; emit: string }>();

/** First two ASCII bytes of a dict key. Skip trieGet when the token cannot match. */
const PREFIX2 = new Uint8Array(16384);
/** Packed first three ASCII bytes. Cuts PREFIX2 collisions (when/callback/health). */
const PREFIX3 = new Set<number>();

function dictPut(k: string, kind: DictKind, emit: string) {
  if (TOKEN_MAP.has(k)) return;
  TOKEN_MAP.set(k, { kind, emit });
  if (k.length >= 2) {
    const a = k.charCodeAt(0);
    const b = k.charCodeAt(1);
    if (a < 128 && b < 128) {
      PREFIX2[(a << 7) | b] = 1;
      if (k.length >= 3) {
        const c = k.charCodeAt(2);
        if (c < 128) PREFIX3.add((a << 16) | (b << 8) | c);
      }
    }
  }
}

for (const h of HEADER_SET) dictPut(h, "header", h);
for (const m of METHOD_SET) dictPut(m, "method", m);
for (const p of PROTO_SET) dictPut(p, "proto", p);
for (const s of SCHEME_SET) dictPut(s, "scheme", s);
for (const d of DNS_BARE) dictPut(d, "dns", d);
for (const d of DNS_SET) if (!DNS_BARE.has(d)) dictPut(d, "dnsCtx", d);
dictPut("RFC", "rfcLead", "RFC");
dictPut("rfc", "rfcLead", "RFC");
dictPut("HTTP", "httpLead", "HTTP");
dictPut("http", "httpLead", "HTTP");
dictPut("W3C", "w3cLead", "W3C");
dictPut("w3c", "w3cLead", "W3C");
dictPut("WHATWG", "whatwgLead", "WHATWG");
dictPut("whatwg", "whatwgLead", "WHATWG");
dictPut("return", "statusLead", "return");
dictPut("Return", "statusLead", "return");
dictPut("RETURN", "statusLead", "return");
dictPut("status", "statusLead", "status");
dictPut("Status", "statusLead", "status");
dictPut("STATUS", "statusLead", "status");
dictPut("code", "statusLead", "code");
dictPut("Code", "statusLead", "code");
dictPut("CODE", "statusLead", "code");
dictPut("SPDX-License-Identifier", "spdxHdr", "");
dictPut("spdx-license-identifier", "spdxHdr", "");
dictPut("Unicode", "unicodeLead", "Unicode");
dictPut("unicode", "unicodeLead", "Unicode");
dictPut("script", "scriptLead", "script");
dictPut("Script", "scriptLead", "script");
dictPut("IANA", "ianaLead", "IANA");
dictPut("iana", "ianaLead", "IANA");
dictPut("capital", "capitalLead", "capital");
dictPut("Capital", "capitalLead", "capital");
dictPut("DNS", "dnsLead", "DNS");
dictPut("dns", "dnsLead", "DNS");
dictPut("json", "jsonWord", "json");
dictPut("JSON", "jsonWord", "json");
dictPut("media", "mediaWord", "media");
dictPut("Media", "mediaWord", "media");
dictPut("license", "licenseWord", "license");
dictPut("License", "licenseWord", "license");
dictPut("licensed", "licenseWord", "license");
dictPut("Licensed", "licenseWord", "license");
dictPut("record", "recordWord", "record");
dictPut("Record", "recordWord", "record");
dictPut("scheme", "schemeCue", "scheme");
dictPut("Scheme", "schemeCue", "scheme");
dictPut("uri", "schemeCue", "uri");
dictPut("URI", "schemeCue", "uri");
dictPut("Uri", "schemeCue", "uri");
for (const id of SPDX_KEEP) {
  dictPut(id, "spdx", id);
  dictPut(id.toLowerCase(), "spdx", id);
}
{
  const charsets = [
    "utf-8",
    "utf8",
    "us-ascii",
    ...Array.from({ length: 16 }, (_, i) => `iso-8859-${i + 1}`),
    ...Array.from({ length: 10 }, (_, i) => `windows-125${i}`),
    "shift_jis",
    "euc-jp",
    "euc-kr",
    "iso-2022-jp",
    "gb18030",
    "gb2312",
    "gbk",
    "big5",
    "koi8-r",
    "koi8-u",
    "ibm437",
  ];
  for (const c of charsets) {
    const emit = canonCharset(c);
    if (!emit) continue;
    CHARSET_EMIT.set(c, emit);
    CHARSET_EMIT.set(c.toLowerCase(), emit);
    CHARSET_EMIT.set(c.toUpperCase(), emit);
    dictPut(c, "charset", emit);
    dictPut(c.toLowerCase(), "charset", emit);
    dictPut(c.toUpperCase(), "charset", emit);
  }
}

type TrieNode = { next?: TrieNode[]; rec?: { kind: DictKind; emit: string } };
const TOKEN_TRIE: TrieNode = {};
for (const [k, rec] of TOKEN_MAP) {
  let n = TOKEN_TRIE;
  let ok = true;
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (c > 127) {
      ok = false;
      break;
    }
    if (!n.next) n.next = new Array(128);
    let ch = n.next[c];
    if (!ch) {
      ch = {};
      n.next[c] = ch;
    }
    n = ch;
  }
  if (ok && !n.rec) n.rec = rec;
}

function trieGet(slice: string, i: number, end: number): { kind: DictKind; emit: string } | undefined {
  let n = TOKEN_TRIE;
  for (let k = i; k < end; k++) {
    const next = n.next;
    if (!next) return;
    const ch = next[slice.charCodeAt(k)];
    if (!ch) return;
    n = ch;
  }
  return n.rec;
}

function isTokStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isTokChar(c: number): boolean {
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    c === 43 ||
    c === 46 ||
    c === 45
  );
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function skipSpace(slice: string, i: number, n: number): number {
  while (i < n && slice.charCodeAt(i) <= 32) i++;
  return i;
}

function eqFoldAt(slice: string, i: number, want: string): boolean {
  const n = want.length;
  if (i + n > slice.length) return false;
  for (let k = 0; k < n; k++) {
    let a = slice.charCodeAt(i + k);
    let b = want.charCodeAt(k);
    if (a >= 65 && a <= 90) a += 32;
    if (b >= 65 && b <= 90) b += 32;
    if (a !== b) return false;
  }
  return true;
}

function boundWord(slice: string, i: number, len: number): boolean {
  if (i > 0 && isTokChar(slice.charCodeAt(i - 1))) return false;
  const end = i + len;
  if (end < slice.length && isTokChar(slice.charCodeAt(end))) return false;
  return true;
}

function statusAt(slice: string, i: number): string | undefined {
  if (i + 2 >= slice.length) return;
  const a = slice.charCodeAt(i);
  const b = slice.charCodeAt(i + 1);
  const c = slice.charCodeAt(i + 2);
  if (a < 49 || a > 53 || !isDigit(b) || !isDigit(c)) return;
  const next = i + 3 < slice.length ? slice.charCodeAt(i + 3) : 0;
  if (isDigit(next) || isTokStart(next)) return;
  return slice.slice(i, i + 3);
}

function mimeAtSlash(slice: string, slash: number): string | undefined {
  let a = slash - 1;
  while (a >= 0 && isTokChar(slice.charCodeAt(a))) a--;
  const typeLen = slash - (a + 1);
  if (typeLen === 11) {
    if (!eqFoldAt(slice, a + 1, "application")) return;
  } else if (typeLen === 4) {
    if (!eqFoldAt(slice, a + 1, "text")) return;
  } else if (typeLen === 5) {
    if (!eqFoldAt(slice, a + 1, "image") && !eqFoldAt(slice, a + 1, "audio") && !eqFoldAt(slice, a + 1, "video")) {
      return;
    }
  } else return;
  let b = slash + 1;
  const n = slice.length;
  while (b < n && isTokChar(slice.charCodeAt(b))) b++;
  while (b - 1 > slash + 1) {
    const last = slice.charCodeAt(b - 1);
    if (last === 46 || last === 45 || last === 95) b--;
    else break;
  }
  if (b <= slash + 1) return;
  const subLen = b - (slash + 1);
  if (typeLen === 11 && subLen === 4 && eqFoldAt(slice, slash + 1, "json")) return "application/json";
  const type = slice.slice(a + 1, slash).toLowerCase();
  const sub = slice.slice(slash + 1, b).toLowerCase();
  if (!aliasableMediaSubtype(sub)) return;
  return `${type}/${sub}`;
}

function gluedRfcAt(slice: string, i: number, end: number): string | undefined {
  const wLen = end - i;
  if (wLen < 6 || wLen > 8) return;
  const c0 = slice.charCodeAt(i);
  const c1 = slice.charCodeAt(i + 1);
  const c2 = slice.charCodeAt(i + 2);
  if ((c0 !== 82 && c0 !== 114) || (c1 !== 70 && c1 !== 102) || (c2 !== 67 && c2 !== 99)) return;
  const d0 = i + 3;
  if (end - d0 < 3 || end - d0 > 5) return;
  for (let k = d0; k < end; k++) if (!isDigit(slice.charCodeAt(k))) return;
  return slice.slice(d0, end);
}

function wellKnownAt(slice: string, i: number): string | undefined {
  let p = i;
  if (slice.charCodeAt(p) === 47) p++;
  if (p >= slice.length || slice.charCodeAt(p) !== 46) return;
  if (!eqFoldAt(slice, p + 1, "well-known")) return;
  const slash = p + 11;
  if (slash >= slice.length || slice.charCodeAt(slash) !== 47) return;
  let b = slash + 1;
  const n = slice.length;
  const c0 = b < n ? slice.charCodeAt(b) : 0;
  if (!((c0 >= 97 && c0 <= 122) || (c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90))) return;
  b++;
  while (b < n) {
    const c = slice.charCodeAt(b);
    if (
      (c >= 97 && c <= 122) ||
      (c >= 65 && c <= 90) ||
      (c >= 48 && c <= 57) ||
      c === 46 ||
      c === 95 ||
      c === 45
    ) {
      b++;
      if (b - (slash + 1) > 48) return;
    } else break;
  }
  const name = slice.slice(slash + 1, b);
  if (name.length < 1) return;
  return `IANA well-known ${name.toLowerCase()}`;
}

function takeTok(slice: string, i: number, n: number): { w: string; end: number } | undefined {
  if (i >= n || !isTokStart(slice.charCodeAt(i))) return;
  let e = i + 1;
  while (e < n && isTokChar(slice.charCodeAt(e))) e++;
  let end = e;
  while (end - i > 2) {
    const last = slice.charCodeAt(end - 1);
    if (last === 46 || last === 45 || last === 95) end--;
    else break;
  }
  if (end - i < 1) return;
  return { w: slice.slice(i, end), end: e };
}

function capitalNameAt(slice: string, i: number, n: number): string | undefined {
  if (i >= n) return;
  const c0 = slice.charCodeAt(i);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return;
  let e = i + 1;
  let last = e;
  while (e < n && e - i <= 41) {
    const c = slice.charCodeAt(e);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 32) {
      if (c !== 32) last = e + 1;
      e++;
    } else break;
  }
  if (last - i < 2) return;
  let name = slice.slice(i, last);
  if (eqFoldAt(name, 0, "the") && name.length > 4 && name.charCodeAt(3) === 32) name = name.slice(4);
  else if ((eqFoldAt(name, 0, "a") && name.length > 2 && name.charCodeAt(1) === 32)) name = name.slice(2);
  name = name.trim();
  return name.length >= 2 ? name : undefined;
}

function unicodeBlockAt(slice: string, i: number, n: number): string | undefined {
  if (i >= n) return;
  const c0 = slice.charCodeAt(i);
  if (!isTokStart(c0) && !(c0 >= 48 && c0 <= 57)) return;
  let e = i + 1;
  let last = e;
  while (e < n && e - i <= 41) {
    const c = slice.charCodeAt(e);
    if (isTokChar(c) || c === 32) {
      if (c !== 32) last = e + 1;
      e++;
    } else break;
  }
  if (last - i < 3) return;
  return slice.slice(i, last).trim();
}

function scriptAt(slice: string, i: number, n: number): string | undefined {
  if (i + 4 > n) return;
  const a = slice.charCodeAt(i);
  if (a < 65 || a > 90) return;
  for (let k = 1; k < 4; k++) {
    const d = slice.charCodeAt(i + k);
    if (d < 97 || d > 122) return;
  }
  const next = i + 4 < n ? slice.charCodeAt(i + 4) : 0;
  if (isTokChar(next)) return;
  return slice.slice(i, i + 4);
}

type ScanFlags = {
  json: boolean;
  media: boolean;
  isc: boolean;
  license: boolean;
  dns: boolean;
  record: boolean;
  schemeCue: boolean;
  colonSlash: boolean;
};

/** Single-pass byte scan. No matchAll, no whole-string toLowerCase. */
const DNS_LATER: string[] = [];
const SCHEME_LATER: string[] = [];

function scanClosed(slice: string, add: (q: string) => void, flags: ScanFlags) {
  const n = slice.length;
  const dnsLater = DNS_LATER;
  const schemeLater = SCHEME_LATER;
  dnsLater.length = 0;
  schemeLater.length = 0;
  let i = 0;
  while (i < n) {
    const c = slice.charCodeAt(i);
    if (c === 58 && i + 2 < n && slice.charCodeAt(i + 1) === 47 && slice.charCodeAt(i + 2) === 47) {
      flags.colonSlash = true;
      i += 3;
      continue;
    }
    if (c === 47 || c === 46) {
      const wk = wellKnownAt(slice, i);
      if (wk) add(wk);
      if (c === 47) {
        const mime = mimeAtSlash(slice, i);
        if (mime) add(mime);
      }
      i++;
      continue;
    }
    if (c === 39 || c === 0x2019) {
      if (i + 10 <= n) {
        const s = slice.charCodeAt(i + 1);
        if ((s === 115 || s === 83) && slice.charCodeAt(i + 2) === 32 && eqFoldAt(slice, i + 3, "capital")) {
          const next = i + 10 < n ? slice.charCodeAt(i + 10) : 0;
          if (!isTokChar(next)) {
            const words: string[] = [];
            let p = i;
            while (p > 0 && words.length < 5) {
              while (p > 0 && slice.charCodeAt(p - 1) === 32) p--;
              const wend = p;
              while (p > 0) {
                const d = slice.charCodeAt(p - 1);
                if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 45 || d === 46) p--;
                else break;
              }
              if (p === wend) break;
              const w = slice.slice(p, wend);
              const a0 = w.charCodeAt(0);
              if (a0 < 65 || a0 > 90) break;
              words.unshift(w);
            }
            let name = "";
            for (let start = words.length - 1; start >= 0; start--) {
              const cand = words.slice(start).join(" ");
              if (countryOf(cand)) name = cand;
            }
            if (name.length >= 2) add(`capital of ${name}`);
            i += 10;
            continue;
          }
        }
      }
      i++;
      continue;
    }
    if (!isTokStart(c) && !isDigit(c)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && isTokChar(slice.charCodeAt(j))) j++;
    let end = j;
    while (end - i > 2) {
      const last = slice.charCodeAt(end - 1);
      if (last === 46 || last === 45 || last === 95 || last === 44 || last === 59 || last === 58) end--;
      else break;
    }
    const wLen = end - i;
    if (wLen >= 2 && wLen <= 48) {
      const c0 = slice.charCodeAt(i);
      if ((c0 === 82 || c0 === 114) && wLen >= 6 && wLen <= 8) {
        const glued = gluedRfcAt(slice, i, end);
        if (glued) add(`RFC ${glued}`);
      }
      const c1 = slice.charCodeAt(i + 1);
      if (c0 < 128 && c1 < 128 && PREFIX2[(c0 << 7) | c1]) {
        if (wLen >= 3) {
          const c2 = slice.charCodeAt(i + 2);
          if (c2 >= 128 || !PREFIX3.has((c0 << 16) | (c1 << 8) | c2)) {
            i = j;
            continue;
          }
        }
        const rec = trieGet(slice, i, end);
      if (rec) {
        if (rec.kind === "rfcLead") {
          const k = skipSpace(slice, j, n);
          let d = k;
          while (d < n && isDigit(slice.charCodeAt(d))) d++;
          const dn = d - k;
          if (dn >= 1 && dn <= 5) {
            const next = d < n ? slice.charCodeAt(d) : 0;
            if (!isDigit(next) && !isTokStart(next)) add(`RFC ${slice.slice(k, d)}`);
          }
        } else if (rec.kind === "httpLead") {
          const k = skipSpace(slice, j, n);
          const st = statusAt(slice, k);
          if (st) add(st);
        } else if (rec.kind === "w3cLead") {
          const k = skipSpace(slice, j, n);
          const tok = takeTok(slice, k, n);
          if (tok && tok.w.length >= 3 && tok.w.length <= 40) add(`W3C ${tok.w}`);
        } else if (rec.kind === "whatwgLead") {
          const k = skipSpace(slice, j, n);
          const tok = takeTok(slice, k, n);
          if (tok && tok.w.length >= 2 && tok.w.length <= 40) add(`WHATWG ${tok.w}`);
        } else if (rec.kind === "scheme") {
          schemeLater.push(rec.emit);
        } else if (rec.kind === "dnsCtx") {
          dnsLater.push(rec.emit);
        } else if (rec.kind === "spdx") {
          if (rec.emit === "ISC") flags.isc = true;
          else add(rec.emit);
        } else if (rec.kind === "statusLead") {
          let k = skipSpace(slice, j, n);
          if (rec.emit === "status" && k + 4 <= n && eqFoldAt(slice, k, "code") && boundWord(slice, k, 4)) {
            k = skipSpace(slice, k + 4, n);
          }
          const st = statusAt(slice, k);
          if (st) add(st);
        } else if (rec.kind === "spdxHdr") {
          let k = skipSpace(slice, j, n);
          if (k < n && slice.charCodeAt(k) === 58) k = skipSpace(slice, k + 1, n);
          const tok = takeTok(slice, k, n);
          if (tok) add(SPDX_LC.get(tok.w.toLowerCase()) || tok.w);
        } else if (rec.kind === "unicodeLead") {
          const k = skipSpace(slice, j, n);
          if (eqFoldAt(slice, k, "block") && boundWord(slice, k, 5)) {
            const name = unicodeBlockAt(slice, skipSpace(slice, k + 5, n), n);
            if (name) add(`Unicode Block ${name}`);
          } else if (eqFoldAt(slice, k, "script") && boundWord(slice, k, 6)) {
            const sc = scriptAt(slice, skipSpace(slice, k + 6, n), n);
            if (sc) add(sc);
          }
        } else if (rec.kind === "scriptLead") {
          const k = skipSpace(slice, j, n);
          const sc = scriptAt(slice, k, n);
          if (sc) add(sc);
        } else if (rec.kind === "ianaLead") {
          let k = skipSpace(slice, j, n);
          if (eqFoldAt(slice, k, "language") && boundWord(slice, k, 8)) {
            k = skipSpace(slice, k + 8, n);
            if (eqFoldAt(slice, k, "subtag") && boundWord(slice, k, 6)) k = skipSpace(slice, k + 6, n);
            if (k + 2 <= n) {
              const next = k + 2 < n ? slice.charCodeAt(k + 2) : 0;
              const wordCont = (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || isDigit(next) || next === 95;
              if (!wordCont) {
                const a = slice.charCodeAt(k);
                const b = slice.charCodeAt(k + 1);
                const la = a >= 65 && a <= 90 ? a + 32 : a;
                const lb = b >= 65 && b <= 90 ? b + 32 : b;
                if (la >= 97 && la <= 122 && lb >= 97 && lb <= 122) add(`IANA language ${String.fromCharCode(la, lb)}`);
              }
            }
          }
        } else if (rec.kind === "capitalLead") {
          const k = skipSpace(slice, j, n);
          if (eqFoldAt(slice, k, "of") && boundWord(slice, k, 2)) {
            const name = capitalNameAt(slice, skipSpace(slice, k + 2, n), n);
            if (name) add(`capital of ${name}`);
          }
        } else if (rec.kind === "dnsLead") {
          flags.dns = true;
          const k = skipSpace(slice, j, n);
          const tok = takeTok(slice, k, n);
          if (tok) {
            if (tok.w.length === 1 && (tok.w === "A" || tok.w === "a")) add("IANA dns A");
            else if (eqFoldAt(tok.w, 0, "https") && tok.w.length === 5) add("IANA dns HTTPS");
          }
        } else if (rec.kind === "jsonWord") flags.json = true;
        else if (rec.kind === "mediaWord") flags.media = true;
        else if (rec.kind === "licenseWord") flags.license = true;
        else if (rec.kind === "recordWord") flags.record = true;
        else if (rec.kind === "schemeCue") flags.schemeCue = true;
        else add(rec.emit);
      }
      }
    }
    i = j;
  }
  if (flags.colonSlash || flags.schemeCue) for (const s of schemeLater) add(s);
  if (flags.dns || flags.record) for (const d of dnsLater) add(d);
}

function canonCharset(raw: string): string | undefined {
  let t = raw;
  const n = t.length;
  if (n >= 2) {
    const a = t.charCodeAt(0);
    const b = t.charCodeAt(n - 1);
    if ((a === 34 || a === 39) && b === a) t = t.slice(1, -1);
  }
  if (t.length === 4 && eqFoldAt(t, 0, "utf8")) return "UTF-8";
  if (t.length === 5 && eqFoldAt(t, 0, "utf-8")) return "UTF-8";
  const hit = CHARSET_EMIT.get(t);
  if (hit) return hit;
  if (
    eqFoldAt(t, 0, "us-ascii") && t.length === 8 ||
    (t.length >= 10 && eqFoldAt(t, 0, "iso-8859-")) ||
    (t.length >= 11 && eqFoldAt(t, 0, "windows-125")) ||
    eqFoldAt(t, 0, "shift_jis") ||
    eqFoldAt(t, 0, "euc-jp") ||
    eqFoldAt(t, 0, "euc-kr") ||
    eqFoldAt(t, 0, "iso-2022-jp") ||
    eqFoldAt(t, 0, "gb18030") ||
    eqFoldAt(t, 0, "gb2312") ||
    eqFoldAt(t, 0, "gbk") ||
    eqFoldAt(t, 0, "big5") ||
    eqFoldAt(t, 0, "koi8-r") ||
    eqFoldAt(t, 0, "koi8-u") ||
    eqFoldAt(t, 0, "ibm437")
  ) {
    return t;
  }
  return undefined;
}

function isStatus(t: string): boolean {
  return t.length === 3 && t >= "100" && t <= "599";
}

function isMediaNeedle(t: string): boolean {
  const n = t.length;
  let slash = -1;
  for (let i = 0; i < n; i++) {
    if (t.charCodeAt(i) === 47) {
      slash = i;
      break;
    }
  }
  if (slash < 4 || slash + 1 >= n) return false;
  if (slash === 11) {
    if (!eqFoldAt(t, 0, "application")) return false;
  } else if (slash === 4) {
    if (!eqFoldAt(t, 0, "text")) return false;
  } else if (slash === 5) {
    if (!eqFoldAt(t, 0, "image") && !eqFoldAt(t, 0, "audio") && !eqFoldAt(t, 0, "video")) return false;
  } else return false;
  for (let i = slash + 1; i < n; i++) {
    let d = t.charCodeAt(i);
    if (d >= 65 && d <= 90) d += 32;
    if (!((d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 43 || d === 46 || d === 45)) return false;
  }
  return true;
}

/**
 * Lower is more specific. RFC number > media type > HTTP status > header/charset >
 * SPDX > W3C/WHATWG > protocol/scheme > HTTP method.
 */
export function needleRank(q: string): number {
  const t = q.trim();
  const n = t.length;
  if (n >= 7 && n <= 10 && (t.startsWith("RFC ") || t.startsWith("rfc "))) {
    const rest = t.slice(4);
    if (rest.length >= 3 && rest.length <= 5 && rest === String(+rest)) return 0;
  }
  if (n >= 10 && t.slice(0, 9).toLowerCase() === "used for ") return 1;
  if (t.includes("/") && isMediaNeedle(t)) return 1;
  if (n === 4 && (t === "json" || t === "JSON")) return 1;
  if (n >= 12 && t.slice(0, 11).toLowerCase() === "capital of ") return 2;
  if (isStatus(t)) return 3;
  if (HEADER_SET.has(t) || CHARSET_EMIT.has(t) || (n >= 15 && t.slice(0, 14).toLowerCase() === "iana language ")) {
    return 4;
  }
  if ((n >= 3 && t.charCodeAt(0) === 83 && t.startsWith("SPDX")) || t === "MIT" || SPDX_LC.has(t.toLowerCase())) {
    return 5;
  }
  if (
    (n >= 4 && t.charCodeAt(0) === 87 && (t.startsWith("W3C ") || t.startsWith("WHATWG "))) ||
    t.startsWith("Unicode Block ") ||
    (n === 4 && t.charCodeAt(0) >= 65 && t.charCodeAt(0) <= 90 && t.charCodeAt(1) >= 97)
  ) {
    return 6;
  }
  const up = t.toUpperCase();
  if (
    PROTO_SET.has(up) ||
    SCHEME_SET.has(t.toLowerCase()) ||
    DNS_SET.has(up) ||
    (n >= 9 && t.slice(0, 9).toLowerCase() === "iana dns ") ||
    (n >= 16 && t.slice(0, 16).toLowerCase() === "iana well-known ")
  ) {
    return 7;
  }
  if (METHOD_SET.has(up) && n <= 7) return 8;
  return 9;
}

/** Serving lane for a needle. Token is cold/wiki; everything else is the hot catalog shard. */
export type NeedleLane = "rfc" | "media" | "capital" | "status" | "header" | "spdx" | "catalog" | "method" | "token";

export function needleLane(q: string): NeedleLane {
  switch (needleRank(q)) {
    case 0:
      return "rfc";
    case 1:
      return "media";
    case 2:
      return "capital";
    case 3:
      return "status";
    case 4:
      return "header";
    case 5:
      return "spdx";
    case 6:
    case 7:
      return "catalog";
    case 8:
      return "method";
    default:
      return "token";
  }
}

export function rankNeedles(qs: string[]): string[] {
  const n = qs.length;
  if (n <= 1) return qs;
  const out = qs.slice();
  const rank = new Array<number>(n);
  for (let i = 0; i < n; i++) rank[i] = needleRank(out[i]!);
  for (let i = 1; i < n; i++) {
    const q = out[i]!;
    const r = rank[i]!;
    let j = i;
    while (j > 0 && rank[j - 1]! > r) {
      out[j] = out[j - 1]!;
      rank[j] = rank[j - 1]!;
      j--;
    }
    out[j] = q;
    rank[j] = r;
  }
  return out;
}

function likelyNeedles(slice: string): boolean {
  const n = slice.length;
  for (let i = 0; i < n; i++) {
    const c = slice.charCodeAt(i);
    if (c === 47 || c === 39 || c === 0x2019 || (c >= 48 && c <= 57)) return true;
  }
  for (let i = 0; i < n; i++) {
    const c = slice.charCodeAt(i);
    if (i > 0 && isTokChar(slice.charCodeAt(i - 1))) continue;
    if (c === 82 || c === 114) {
      if (eqFoldAt(slice, i, "rfc") && boundWord(slice, i, 3)) return true;
      if (eqFoldAt(slice, i, "record") && boundWord(slice, i, 6)) return true;
      if (eqFoldAt(slice, i, "recommend") && boundWord(slice, i, 9)) return true;
    } else if (c === 71 || c === 103) {
      if (eqFoldAt(slice, i, "get") && boundWord(slice, i, 3)) return true;
    } else if (c === 80 || c === 112) {
      if (eqFoldAt(slice, i, "post") && boundWord(slice, i, 4)) return true;
      if (eqFoldAt(slice, i, "put") && boundWord(slice, i, 3)) return true;
      if (eqFoldAt(slice, i, "patch") && boundWord(slice, i, 5)) return true;
    } else if (c === 72 || c === 104) {
      if (eqFoldAt(slice, i, "http") && boundWord(slice, i, 4)) return true;
      if (eqFoldAt(slice, i, "head") && boundWord(slice, i, 4)) return true;
    } else if (c === 87 || c === 119) {
      if (eqFoldAt(slice, i, "w3c") && boundWord(slice, i, 3)) return true;
      if (eqFoldAt(slice, i, "whatwg") && boundWord(slice, i, 6)) return true;
      if (eqFoldAt(slice, i, "want") && boundWord(slice, i, 4)) return true;
    } else if (c === 66 || c === 98) {
      if (eqFoldAt(slice, i, "best") && boundWord(slice, i, 4)) return true;
    } else if (c === 83 || c === 115) {
      if (eqFoldAt(slice, i, "spdx") && boundWord(slice, i, 4)) return true;
      if (eqFoldAt(slice, i, "script") && boundWord(slice, i, 6)) return true;
      if (eqFoldAt(slice, i, "scheme") && boundWord(slice, i, 6)) return true;
      if (eqFoldAt(slice, i, "should") && boundWord(slice, i, 6)) return true;
    } else if (c === 78 || c === 110) {
      if (eqFoldAt(slice, i, "need") && boundWord(slice, i, 4)) return true;
      if (eqFoldAt(slice, i, "ndjson") && boundWord(slice, i, 6)) return true;
    } else if (c === 77 || c === 109) {
      if (eqFoldAt(slice, i, "mit") && boundWord(slice, i, 3)) return true;
    } else if (c === 84 || c === 116) {
      if (eqFoldAt(slice, i, "tcp") && boundWord(slice, i, 3)) return true;
      if (eqFoldAt(slice, i, "trying") && boundWord(slice, i, 6)) return true;
      if (eqFoldAt(slice, i, "tool") && boundWord(slice, i, 4)) return true;
    } else if (c === 85 || c === 117) {
      if (eqFoldAt(slice, i, "udp") && boundWord(slice, i, 3)) return true;
      if (eqFoldAt(slice, i, "uri") && boundWord(slice, i, 3)) return true;
      if (eqFoldAt(slice, i, "utf") && boundWord(slice, i, 3)) return true;
      if (eqFoldAt(slice, i, "utf-8") && boundWord(slice, i, 5)) return true;
      if (eqFoldAt(slice, i, "unicode") && boundWord(slice, i, 7)) return true;
    } else if (c === 73 || c === 105) {
      if (eqFoldAt(slice, i, "iana") && boundWord(slice, i, 4)) return true;
    } else if (c === 68 || c === 100) {
      if (eqFoldAt(slice, i, "dns") && boundWord(slice, i, 3)) return true;
      if (eqFoldAt(slice, i, "delete") && boundWord(slice, i, 6)) return true;
    } else if (c === 65 || c === 97) {
      if (eqFoldAt(slice, i, "accept") && boundWord(slice, i, 6)) return true;
    } else if (c === 67 || c === 99) {
      if (eqFoldAt(slice, i, "cookie") && boundWord(slice, i, 6)) return true;
      if (eqFoldAt(slice, i, "capital") && boundWord(slice, i, 7)) return true;
      if (eqFoldAt(slice, i, "charset") && boundWord(slice, i, 7)) return true;
      if (eqFoldAt(slice, i, "content-type") && boundWord(slice, i, 12)) return true;
    } else if (c === 76 || c === 108) {
      if (eqFoldAt(slice, i, "language") && boundWord(slice, i, 8)) return true;
    } else if (c === 74 || c === 106) {
      if (eqFoldAt(slice, i, "json") && boundWord(slice, i, 4)) return true;
    }
  }
  return false;
}

const TECHNIQUE_CUE =
  /\b(?:(?:what(?:'s| is) the |the )?(?:best|right|usual|standard|recommended|good|proper|correct) (?:way|tool|thing)(?: to use)? (?:to|for)|what(?: should i)?(?: to)? use (?:to|for)|which (?:tool|thing) (?:should i use |to use )?(?:to|for)|is there a (?:way|tool) to|looking for a (?:way|tool) to|anyone know how to|how(?:\s+do(?:es)?(?:\s+(?:i|you|one|we))?|\s+can(?:\s+i)?|\s+would(?:\s+i)?|\s+should(?:\s+i)?|\s+to))\s+([^?!.]+)/i;
const INTENT_CUE =
  /\b(?:(?:need(?:s)?|trying|want(?:ing)?|looking) to|(?:can|could) (?:i|you|we|one)|help me|any(?: good)? (?:way|tool) to|recommend(?:ed)? (?:a )?(?:tool|way|something) (?:to|for)|(?:alternative|replacement) to \S+ for|tool for)\s+([^?!.]+)/i;
const LEAD_VERB =
  /^(?:(use|do|get|make)(?:ing|es|ne)?)\s+/i;

const TASK_OBJ =
  "jsonl?|ndjson|yaml|toml|xml|html|markdown|typescript|javascript|rustc|rust|python|sql|bash|csv|regex|protobuf|graphql|docker|kubernetes|sqlite|postgres|golang|ruby|php|css|terraform|nix|redis|parquet|avro|repo|codebase";
const TASK_VERB =
  "filter|parse|query|run|execute|build|compile|lint|format|bundle|deploy|extract|search|replace|convert|encode|decode|serialize|stream|pretty-?print|minify|validate|print|pull|pluck|slice";
const TASK_OBJ_RE = new RegExp(`^(?:${TASK_OBJ})$`, "i");
const TASK_OBJ_HIT = new RegExp(`\\b(?:${TASK_OBJ})\\b`, "i");
const GREP_LINE = /\b(?:grep|ripgrep|rg|sed|awk|cat|perl|cut)\b/i;
const PIP_LIKE = /\b(?:pip3?|easy_install|python\s+-m\s+pip)\b/i;
const JS_PKG = /\b(?:npm|yarn|pnpm|bun)\b/i;
const JSON_STRUCT = /\b(?:ids?|keys?|nested|fields?|items?|jsonpath|ndjson|jsonl|values?)\b/i;

export function configJsonPath(s: string): boolean {
  return /\b(?:package|tsconfig|jsconfig|composer|deno)\.json\b/i.test(s);
}

export function jsonTaskToken(text: string): boolean {
  if (text.indexOf("json") < 0 && text.indexOf("JSON") < 0) return false;
  if (/\bndjson\b|\bjsonl\b/i.test(text)) return true;
  if (configJsonPath(text) && !JSON_STRUCT.test(text)) return false;
  if ((/\b(?:content-type|media type|iana)\b/i.test(text) || /application\/json/i.test(text)) && !/\.(jsonl?|ndjson)\b/i.test(text)) {
    return false;
  }
  return /\bjson\b|\.jsonl?\b/i.test(text.replace(/application\/(?:ld\+)?json/gi, " "));
}

export function jsonWrongWay(text: string): boolean {
  if (!GREP_LINE.test(text) || !jsonTaskToken(text)) return false;
  if (/\b(?:repo|codebase|source tree)\b/i.test(text) && !/\.(jsonl?|ndjson)\b/i.test(text)) return false;
  return true;
}

export function jsonCliNeed(text: string): boolean {
  if (!jsonTaskToken(text)) return false;
  if (/\b(?:repo|codebase|source tree)\b/i.test(text) && !/\.(jsonl?|ndjson)\b/i.test(text) && !/\bndjson\b|\bjsonl\b/i.test(text)) {
    return false;
  }
  if (GREP_LINE.test(text)) return true;
  const struct = JSON_STRUCT.test(text);
  if (struct && /\.(jsonl?|ndjson)\b/i.test(text) && /\b(?:pull|pluck|grep|cat|sed|awk|extract|parse|get|read|print)\b/i.test(text)) {
    return true;
  }
  const stripped = text.replace(/application\/json/gi, " ");
  if (/\bjson\b/i.test(stripped) && /\bcli\b/i.test(text)) return true;
  return struct && /\b(?:bash|shell|cli|terminal|stdout|command[ -]?line|pipeline)\b/i.test(text);
}

export function jsonToolArgs(args: string): boolean {
  if (configJsonPath(args) && !/\b(?:jsonpath|ndjson|jsonl)\b/i.test(args) && !JSON_STRUCT.test(args)) {
    return false;
  }
  if (/\.(jsonl?|ndjson)\b/i.test(args)) return true;
  if (/\bjsonpath\b|\bndjson\b|\bjsonl\b/i.test(args)) return true;
  return false;
}

export function pythonInstallNeed(text: string): boolean {
  if (text.indexOf("pip") < 0 && text.indexOf("python") < 0 && text.indexOf("Python") < 0 && text.indexOf("easy_install") < 0) {
    return false;
  }
  if (PIP_LIKE.test(text)) return !/\b(?:freeze|list|show|uninstall|outdated)\b/i.test(text);
  if (!/\bpython\b/i.test(text) || JS_PKG.test(text)) return false;
  return /\binstall(?:ing)?\b/i.test(text) || /\b(?:pypi|python packages|python deps)\b/i.test(text);
}

export function typescriptRunNeed(text: string): boolean {
  if (text.indexOf("tsc") < 0 && text.indexOf("tsx") < 0 && text.indexOf("typescript") < 0 && text.indexOf("TypeScript") < 0 && text.indexOf("ts-node") < 0) {
    return false;
  }
  if (/\b(?:tsc|ts-node|(?:npx\s+)?tsx)\b/i.test(text)) return true;
  return /\btypescript\b/i.test(text) && /\b(?:compile step|without a compile|skip(?:ping)? (?:the )?compile|as-is|just start)\b/i.test(text);
}

export function findFilesNeed(text: string): boolean {
  if (text.indexOf("file") < 0 && text.indexOf("glob") < 0 && text.indexOf("find") < 0 && text.indexOf("locate") < 0) return false;
  if (/\bfile named\b/i.test(text) || (/\bglob\b/i.test(text) && /\b(?:tree|tsconfig)\b/i.test(text))) return true;
  if (/\bfind\b/i.test(text) && /\s-i?name\b/.test(text)) return true;
  if (!/\b(?:find|locate)\b/i.test(text)) return false;
  return /\b(?:files named|files? by name|by filename|filenames?)\b/i.test(text) || (/\bfiles?\b/i.test(text) && /\bglob\b/i.test(text));
}

export function repoSearchNeed(text: string): boolean {
  if (/\.(jsonl?|ndjson)\b/i.test(text) || /\bndjson\b|\bjsonl\b/i.test(text)) return false;
  if (!/\b(?:repo|codebase|source tree)\b/i.test(text)) return false;
  if (/\b(?:search|grep|ripgrep|rg)\b/i.test(text)) return true;
  return /\b(?:todo|symbol)\b/i.test(text) && /\b(?:hunt|find|look|search|grep)\b/i.test(text);
}

function jsonTechniqueBlockedByRfc(text: string): boolean {
  if (!/\bRFC[\s#:-]*\d{1,5}\b/i.test(text)) return false;
  if (GREP_LINE.test(text)) return false;
  if (/\b(?:cli|command[ -]?line|bash|shell)\b/i.test(text)) return false;
  if (/\.(jsonl?|ndjson)\b/i.test(text)) return false;
  return true;
}

function canonTaskObj(obj: string): string {
  if (/^(jsonl|ndjson)$/i.test(obj)) return "JSON";
  if (/^rustc$/i.test(obj)) return "Rust";
  return obj;
}

function cleanTask(raw: string): string | undefined {
  let task = raw.replace(/\s+/g, " ").trim().replace(/^(to|for|a|an|the)\s+/i, "").replace(/[?!.]+$/, "").trim();
  task = task.replace(LEAD_VERB, "").trim();
  if (task.length < 2 || task.length > 60) return undefined;
  return task;
}

export function techniqueTaskFromText(text: string): string | undefined {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 12) return undefined;
  if (!TASK_OBJ_HIT.test(t)) return undefined;
  const m = TECHNIQUE_CUE.exec(t) || INTENT_CUE.exec(t);
  if (!m) return undefined;
  return cleanTask(m[1]!);
}
const TECH_FILLER = new Set([
  "on",
  "the",
  "a",
  "an",
  "of",
  "to",
  "for",
  "and",
  "in",
  "at",
  "by",
  "command",
  "line",
  "cli",
  "tool",
  "using",
  "with",
  "from",
  "into",
  "this",
  "that",
  "nested",
  "output",
  "records",
  "please",
  "just",
]);
const TASK_FWD = new RegExp(
  `\\b(?:${TASK_VERB})(?:ing|es|s|e|ed)?\\b[\\s\\S]{0,48}?\\b(${TASK_OBJ})\\b`,
  "i",
);
const TASK_REV = new RegExp(
  `\\b(${TASK_OBJ})\\b[\\s\\S]{0,48}\\b(?:${TASK_VERB})(?:ing|es|s|e|ed)?\\b`,
  "i",
);

export function implicitTechniqueTask(text: string): string | undefined {
  const t = text.replace(/\s+/g, " ");
  if (t.length < 8) return undefined;
  if (jsonCliNeed(t) && !jsonTechniqueBlockedByRfc(t)) return "JSON";
  if (pythonInstallNeed(t)) return "Python";
  if (typescriptRunNeed(t)) return "TypeScript";
  if (findFilesNeed(t)) return "files";
  if (repoSearchNeed(t)) return "search";
  if ((t.indexOf("rust") >= 0 || t.indexOf("Rust") >= 0) && (t.indexOf("crate") >= 0 || t.indexOf("binary") >= 0) && /\brust\b/i.test(t) && /\b(?:crate|binary)\b/i.test(t)) return "Rust";
  if (!TASK_OBJ_HIT.test(t)) return undefined;
  const m = TASK_FWD.exec(t) || TASK_REV.exec(t);
  if (!m) return undefined;
  const obj = m[1]!.trim();
  const canon = canonTaskObj(obj);
  if (/^JSON$/i.test(canon) && (jsonTechniqueBlockedByRfc(t) || (!jsonTaskToken(t) && !jsonCliNeed(t)))) return undefined;
  if (/^Python$/i.test(canon) && !pythonInstallNeed(t)) return undefined;
  if (/^TypeScript$/i.test(canon) && !typescriptRunNeed(t) && !/\b(?:run|execute|running|executing)s?\b/i.test(t)) {
    return undefined;
  }
  return canon.length >= 2 && canon.length <= 24 ? canon : undefined;
}

function bitsNeedle(task: string): string | undefined {
  const bits = task
    .split(/[^a-zA-Z0-9.+-]+/)
    .filter((w) => w.length > 1 && !/^(on|the|a|an|of|to|for|and|in|at|by)$/i.test(w))
    .map((w) => canonTaskObj(w));
  if (!bits.length) return undefined;
  const q = `used for ${bits.join(" ")}`;
  return q.length >= 10 && q.length <= 80 ? q : undefined;
}

export function techniqueQueryFallbacks(q: string): string[] {
  const t = q.trim();
  if (t.length < 12 || !/^used for /i.test(t)) return [];
  const rest = t.slice(9).trim();
  const bits = rest.split(/[^a-zA-Z0-9.+-]+/).filter((w) => w.length > 1 && !TECH_FILLER.has(w.toLowerCase()));
  const objs = bits.filter((b) => TASK_OBJ_RE.test(b));
  const out: string[] = [];
  const add = (s: string) => {
    if (s.length >= 10 && s.length <= 80 && s.toLowerCase() !== t.toLowerCase() && !out.some((x) => x.toLowerCase() === s.toLowerCase())) {
      out.push(s);
    }
  };
  for (const o of objs) {
    const c = canonTaskObj(o);
    if (bits.some((b) => /^install/i.test(b)) && /python/i.test(c)) {
      add("used for installing Python");
      add("used for installing Python packages");
      continue;
    }
    if (c.toLowerCase() !== o.toLowerCase()) add(`used for ${c}`);
    add(`used for ${o}`);
  }
  if (objs.length > 1) add(`used for ${objs.map(canonTaskObj).join(" ")}`);
  if (bits.some((b) => /^search/i.test(b))) {
    add("used for searching");
    add("used for repo");
  }
  if (bits.length) add(`used for ${bits.map(canonTaskObj).join(" ")}`);
  return out;
}

/** Pack search needle: `used for JSON` so media `json` does not steal the card. */
export function techniqueNeedleFromText(text: string): string | undefined {
  const cued = techniqueTaskFromText(text);
  if (cued) {
    const skipJson =
      (jsonTechniqueBlockedByRfc(text) && /\bjson/i.test(cued)) ||
      (repoSearchNeed(text) && /\bjson/i.test(cued));
    const skipPy = JS_PKG.test(text) && /python/i.test(cued) && !PIP_LIKE.test(text);
    if (!skipJson && !skipPy) {
      const q = bitsNeedle(cued);
      if (q) return q;
    }
  }
  const implicit = implicitTechniqueTask(text);
  return implicit ? bitsNeedle(implicit) : undefined;
}

export function needlesFromText(text: string): string[] {
  const out: string[] = [];
  const add = (q: string) => {
    let t = q;
    const n = t.length;
    if (n < 2 || n > 80) return;
    let compact = t.charCodeAt(0) > 32 && t.charCodeAt(n - 1) > 32;
    if (compact) {
      for (let i = 1; i < n; i++) {
        if (t.charCodeAt(i) <= 32 && t.charCodeAt(i - 1) <= 32) {
          compact = false;
          break;
        }
      }
    }
    if (!compact) {
      t = t.replace(/\s+/g, " ").trim();
      if (t.length < 2 || t.length > 80) return;
    }
    const tn = t.length;
    for (let i = 0; i < out.length; i++) {
      const x = out[i]!;
      if (x.length === tn && eqFoldAt(x, 0, t)) return;
    }
    out.push(t);
  };
  const slice = text.length > 6_000 ? text.slice(0, 6_000) : text;
  if (slice.length < 2) return [];
  const tech = techniqueNeedleFromText(slice);
  if (tech) add(tech);
  if (!likelyNeedles(slice)) {
    scanPhrases(slice, add);
    if (!out.length) return [];
    const ranked = rankNeedles(out);
    return ranked.length > 8 ? ranked.slice(0, 8) : ranked;
  }

  const flags: ScanFlags = {
    json: false,
    media: false,
    isc: false,
    license: false,
    dns: false,
    record: false,
    schemeCue: false,
    colonSlash: false,
  };
  scanClosed(slice, add, flags);
  if (flags.json && flags.media) add("json");
  if (flags.isc && flags.license) add("ISC");
  let rfc = false;
  for (let i = 0; i < out.length; i++) {
    if (needleRank(out[i]!) === 0) {
      rfc = true;
      break;
    }
  }
  if (!rfc) {
    const cover = new Set<string>();
    const before = out.length;
    scanPhrases(slice, add, cover);
    if (cover.size && out.length > before) {
      let w = 0;
      for (let i = 0; i < out.length; i++) {
        const q = out[i]!;
        if (i >= before || cover.has(q)) {
          out[w++] = q;
          continue;
        }
        let f = q;
        if (f.length > 0 && f.charCodeAt(0) >= 65 && f.charCodeAt(0) <= 90) f = f.toLowerCase();
        if (cover.has(f)) continue;
        out[w++] = q;
      }
      out.length = w;
    }
  }

  const ranked = rankNeedles(out);
  return ranked.length > 8 ? ranked.slice(0, 8) : ranked;
}
