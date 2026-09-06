/** Typed subject parsers for pack locate + catalog posting policy. */

import { relNames } from "./rel-tab";
import { wellknownNames } from "./wellknown-tab";

const REL_TAB = new Set(relNames());
const WK_TAB = new Set(wellknownNames());

export function ianaProtocol(s: string): number | undefined {
  const m = /^IANA\s+protocol\s+(\d{1,3})$/i.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return n <= 255 ? n : undefined;
}

export function ianaHttp(s: string): number | undefined {
  const m = /^IANA\s+http\s+(\d{3})$/i.exec(s.trim());
  return m ? Number(m[1]) : undefined;
}

export function ianaMedia(s: string): string | undefined {
  const m = /^IANA\s+media\s+(\S+)$/i.exec(s.trim());
  return m?.[1]?.toLowerCase();
}

export function ianaScheme(s: string): string | undefined {
  const m = /^IANA\s+scheme\s+(\S+)$/i.exec(s.trim());
  return m?.[1]?.toLowerCase();
}

export function spdxId(s: string): string | undefined {
  const m = /^SPDX\s+(\S+)$/i.exec(s.trim());
  return m?.[1];
}

export function whatwgSlug(s: string): string | undefined {
  const m = /^WHATWG\s+(\S+)$/i.exec(s.trim());
  return m?.[1]?.toLowerCase();
}

export function ianaMethod(s: string): string | undefined {
  const m = /^IANA\s+method\s+([A-Z][A-Z0-9-]{0,24})$/i.exec(s.trim());
  return m?.[1]?.toUpperCase();
}

export function ianaRel(s: string): string | undefined {
  const m = /^IANA\s+rel\s+(\S+)$/i.exec(s.trim());
  return m?.[1]?.toLowerCase();
}

export function ianaWellKnown(s: string): string | undefined {
  const m = /^IANA\s+well-known\s+(\S+)$/i.exec(s.trim());
  return m?.[1]?.toLowerCase();
}

export function unicodeScript(s: string): string | undefined {
  const m = /^Unicode Script ([A-Z][a-z]{3})$/.exec(s.trim());
  return m?.[1];
}

export function ianaLanguage(s: string): string | undefined {
  const m = /^IANA\s+language\s+([a-z]{2})$/i.exec(s.trim());
  return m?.[1]?.toLowerCase();
}

export function unicodeBlock(s: string): string | undefined {
  const m = /^Unicode Block (.+)$/i.exec(s.trim());
  const name = m?.[1]?.replace(/\s+/g, " ").trim();
  return name || undefined;
}

export function ianaCharset(s: string): string | undefined {
  const m = /^IANA\s+charset\s+(\S+)$/i.exec(s.trim());
  return m?.[1]?.toLowerCase();
}

export function ianaHeader(s: string): string | undefined {
  const m = /^IANA\s+header\s+(\S+)$/i.exec(s.trim());
  return m?.[1];
}

export function ianaDns(s: string): string | undefined {
  const m = /^IANA\s+dns\s+([A-Z][A-Z0-9-]{0,15})$/i.exec(s.trim());
  return m?.[1]?.toUpperCase();
}

/** When the IANA name is just the subtype, use a stable display object. */
export const MEDIA_SUBTYPE_OBJECT: Record<string, string> = {
  json: "JSON",
  html: "HTML",
  xml: "XML",
  pdf: "PDF",
  png: "PNG",
  jpeg: "JPEG",
  gif: "GIF",
  "svg+xml": "SVG",
  javascript: "JavaScript",
  css: "CSS",
  wasm: "WebAssembly",
  zip: "ZIP",
  yaml: "YAML",
  ndjson: "NDJSON",
  "problem+json": "Problem JSON",
  "event-stream": "Event Stream",
  "octet-stream": "Octet Stream",
  "x-www-form-urlencoded": "Form URL Encoded",
  "form-data": "Form Data",
  "ld+json": "JSON-LD",
  "json-patch+json": "JSON Patch",
  "merge-patch+json": "JSON Merge Patch",
  jose: "JOSE",
  jwt: "JWT",
  "jwk+json": "JWK",
  "jwk-set+json": "JWKS",
  cbor: "CBOR",
  graphql: "GraphQL",
  toml: "TOML",
  csv: "CSV",
  markdown: "Markdown",
  webp: "WebP",
  avif: "AVIF",
  heic: "HEIC",
  woff: "WOFF",
  woff2: "WOFF2",
  mp4: "MP4",
  webm: "WebM",
  ogg: "Ogg",
  gzip: "gzip",
  "manifest+json": "Web Manifest",
  "activity+json": "Activity Streams",
  "atom+xml": "Atom",
  "rss+xml": "RSS",
  "xhtml+xml": "XHTML",
  calendar: "iCalendar",
  vcard: "vCard",
  "vnd.api+json": "JSON:API",
};

export function aliasableMediaSubtype(sub: string): boolean {
  return Object.prototype.hasOwnProperty.call(MEDIA_SUBTYPE_OBJECT, sub.toLowerCase());
}

/** Well-known URI suffixes worth a packed row. Official IANA suffixes plus KEEP extras. */
export const WELLKNOWN_KEEP = new Set([
  "change-password",
  "oauth-authorization-server",
  "openid-configuration",
  "oauth-protected-resource",
  "webfinger",
  "security.txt",
  "acme-challenge",
  "mta-sts.txt",
  "host-meta",
  "host-meta.json",
  "did.json",
  "did-configuration",
  "time",
  "caldav",
  "carddav",
  "dnt",
  "nodeinfo",
  "webauthn",
  "jwks.json",
  "passkey-endpoints",
  "oauth-client",
  "assetlinks.json",
  "apple-app-site-association",
  "api-catalog",
  "openid-credential-issuer",
  "openid-federation",
  "gpc.json",
  "atproto-did",
  "tdmrep.json",
  "web-identity",
  "ai-plugin.json",
]);

/** Schemes worth a packed row. The rest are intern noise and almost never queried. */
export const SCHEME_KEEP = new Set([
  "http",
  "https",
  "mailto",
  "ws",
  "wss",
  "ftp",
  "file",
  "data",
  "blob",
  "git",
  "ssh",
  "urn",
  "about",
  "sftp",
  "ldap",
  "ldaps",
  "tel",
  "sms",
  "sip",
  "sips",
  "xmpp",
  "did",
  "geo",
  "magnet",
  "ipfs",
  "irc",
  "mqtt",
  "coap",
  "coaps",
  "stun",
  "turn",
  "webcal",
  "rtsp",
]);

/** RFC title words that steal catalog aliases in postings. */
export const TITLE_ALIAS_POISON = new Set([
  "json",
  "xml",
  "html",
  "tcp",
  "udp",
  "http",
  "https",
  "zip",
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "css",
  "pdf",
  "png",
  "javascript",
  "wasm",
]);

export const SPDX_KEEP = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "Apache-1.1",
  "BSD-1-Clause",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-2.1-only",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MPL-2.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "0BSD",
  "BlueOak-1.0.0",
  "BSL-1.0",
  "EPL-2.0",
  "OFL-1.1",
  "EUPL-1.2",
  "UPL-1.0",
  "Artistic-2.0",
  "CDDL-1.0",
  "Python-2.0",
  "MS-PL",
]);

export const UNICODE_BLOCK_KEEP = new Set([
  "basic latin",
  "latin-1 supplement",
  "cjk unified ideographs",
  "arabic",
  "cyrillic",
  "hiragana",
  "katakana",
  "hangul syllables",
  "emoji",
  "private use area",
]);

export const UNICODE_SCRIPT_KEEP = new Set(["Latn", "Cyrl", "Grek", "Arab", "Hans", "Hant", "Jpan", "Kore", "Hebr", "Deva", "Thai"]);

export const W3C_KEEP = new Set([
  "web-share",
  "encoding",
  "json-ld11",
  "html",
  "wasm-core-2",
  "uievents",
  "fetch",
  "url",
  "dom",
  "css-color-4",
  "imsc",
  "wai-aria-1.2",
  "webrtc",
  "wcag-22",
  "webauthn-3",
  "service-workers",
  "push-api",
  "webgpu",
  "webcodecs",
  "did-core",
  "geolocation",
  "clipboard-apis",
  "fileapi",
  "webaudio",
  "csp3",
  "permissions",
  "indexeddb-3",
  "css-flexbox-1",
  "css-grid-1",
  "pointerevents3",
]);

export const LANG_KEEP = new Set([
  "en", "fr", "de", "es", "it", "pt", "nl", "sv", "pl", "ru", "zh", "ja", "ko", "ar", "hi", "tr", "uk", "vi", "th", "id", "cs", "ro", "el", "he", "fa",
  "da", "fi", "no", "nb", "hu", "sk", "bg", "hr", "sr", "ms", "bn", "ta", "ur", "sw", "ca", "eu", "ga", "lt", "lv", "et", "af",
]);

/** RFC is-facts worth a packed title. The RFC index dump is thousands of unique English titles; packing all of them is what blew HDT 6% / 5 B/fact. Live pages and IANA xrefs still add a number if it is in this set. */
export const RFC_KEEP = new Set<number>([
  761, 768, 791, 793, 821, 822, 854, 959, 1034, 1035, 1738, 1808, 1918, 1928, 1945, 2045, 2046, 2047,
  2119, 2396, 2460, 2616, 2617, 2732, 2817, 2818, 3339, 3493, 3548, 3596, 3629, 3864, 3986, 3987,
  4122, 4287, 4346, 4551, 4627, 4648, 4861, 4862, 5023, 5246, 5280, 5321, 5322, 5789, 5802, 5849,
  5905, 6106, 6234, 6265, 6454, 6455, 6555, 6574, 6749, 6750, 6761, 6797, 6818, 6838, 6891, 6901,
  7033, 7049, 7089, 7159, 7230, 7231, 7232, 7233, 7234, 7235, 7240, 7301, 7464, 7519, 7538, 7540,
  7578, 7636, 7692, 7693, 7804, 7807, 8030, 8037, 8188, 8252, 8259, 8288, 8297, 8414, 8446, 8447,
  8470, 8482, 8484, 8705, 8725, 8781, 8792, 8879, 8941, 8942, 8996, 9000, 9001, 9002, 9106, 9110,
  9111, 9112, 9113, 9114, 9162, 9200, 9204, 9205, 9218, 9250, 9286, 9293, 9309, 9411, 9417, 9421,
  9440, 9449, 9457, 9458, 9485, 9518, 9521, 9525,
]);

export function packableFact(s: string, p: string, o: string): boolean {
  if (p !== "is" && p !== "obsoletes" && p !== "updates" && p !== "capital") return true;
  const media = ianaMedia(s);
  if (media) return o.length >= 2 && o.length <= 72;
  const sch = ianaScheme(s);
  if (sch) return o.length >= 2 && o.length <= 72;
  const block = unicodeBlock(s);
  if (block) return UNICODE_BLOCK_KEEP.has(block.toLowerCase());
  const script = unicodeScript(s);
  if (script) return UNICODE_SCRIPT_KEEP.has(script);
  const spdx = spdxId(s);
  if (spdx) return o.length >= 2 && o.length <= 72;
  const w3 = /^W3C\s+(\S+)$/i.exec(s.trim())?.[1]?.toLowerCase();
  if (w3) return o.length >= 2 && o.length <= 72;
  const lang = ianaLanguage(s);
  if (lang) return LANG_KEEP.has(lang);
  if (ianaRel(s)) {
    const rel = ianaRel(s)!;
    return REL_TAB.has(rel) && o.length >= 2 && o.length <= 72;
  }
  const wk = ianaWellKnown(s);
  if (wk) return WELLKNOWN_KEEP.has(wk) || WK_TAB.has(wk);
  return true;
}

/** SPDX ids that collide with media/scheme short names. Pack + WAL skip these aliases. */
export function spdxAliasable(id: string): boolean {
  return !/^(json|xml|html|zip|http|https)$/i.test(id);
}

export function catalogSubject(s: string): boolean {
  return (
    /^RFC\s+\d/i.test(s) ||
    /^W3C\s+/i.test(s) ||
    /^(IANA|SPDX|WHATWG)\s+/i.test(s) ||
    /^Unicode (Block|Script) /i.test(s)
  );
}

/** Bare `application/json` (not `IANA media …`). */
export function bareMediaType(s: string): string | undefined {
  const t = s.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(t)) return undefined;
  return t;
}
