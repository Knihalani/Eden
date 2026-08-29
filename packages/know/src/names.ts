/** Typed subject parsers for pack locate + catalog posting policy. */

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
  const m = /^IANA\s+dns\s+([A-Z][A-Z0-9-]{1,15})$/i.exec(s.trim());
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
};

export function aliasableMediaSubtype(sub: string): boolean {
  return Object.prototype.hasOwnProperty.call(MEDIA_SUBTYPE_OBJECT, sub.toLowerCase());
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
