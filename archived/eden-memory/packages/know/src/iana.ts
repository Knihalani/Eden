/** IANA core registries → typed facts. XML, not HTML. Skip ports (too many). */

import type { Triple } from "./extract";
import { MEDIA_SUBTYPE_OBJECT } from "./names";

export const IANA_REGISTRIES = [
  {
    kind: "protocol" as const,
    url: "https://www.iana.org/assignments/protocol-numbers/protocol-numbers.xml",
  },
  {
    kind: "media" as const,
    url: "https://www.iana.org/assignments/media-types/media-types.xml",
  },
  {
    kind: "scheme" as const,
    url: "https://www.iana.org/assignments/uri-schemes/uri-schemes.xml",
  },
  {
    kind: "http" as const,
    url: "https://www.iana.org/assignments/http-status-codes/http-status-codes.xml",
  },
  {
    kind: "method" as const,
    url: "https://www.iana.org/assignments/http-methods/http-methods.xml",
  },
  {
    kind: "rel" as const,
    url: "https://www.iana.org/assignments/link-relations/link-relations.xml",
  },
  {
    kind: "wellknown" as const,
    url: "https://www.iana.org/assignments/well-known-uris/well-known-uris.xml",
  },
  {
    kind: "charset" as const,
    url: "https://www.iana.org/assignments/character-sets/character-sets.xml",
  },
  {
    kind: "header" as const,
    url: "https://www.iana.org/assignments/http-fields/http-fields.xml",
  },
  {
    kind: "dns" as const,
    url: "https://www.iana.org/assignments/dns-parameters/dns-parameters.xml",
  },
];

function xmlField(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>\\s*([^<]*)\\s*</${tag}>`, "i"));
  return (m?.[1] ?? "").replace(/\s+/g, " ").trim();
}

function xmlAttr(block: string, tag: string, attr: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*\\b${attr}=["']([^"']+)["']`, "i"));
  return (m?.[1] ?? "").trim();
}

function xmlAttrField(block: string, tag: string, attr: string, val: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*${attr}=["']${val}["'][^>]*>\\s*([^<]*)\\s*</${tag}>`, "i"));
  return (m?.[1] ?? "").replace(/\s+/g, " ").trim();
}

const SKIP_NAME = /^(unassigned|reserved|deprecated|private encryption|experimental)$/i;
const CHARSET_KEEP = new RegExp(
  String.raw`^(utf-8|us-ascii|iso-8859-\d+|windows-125\d|shift_jis|euc-jp|euc-kr|gbk|gb2312|gb18030|big5|` +
    String.raw`koi8-r|koi8-u|macintosh|ibm437|iso-2022-jp)$`,
  "i",
);

export function parseIanaRecord(block: string, kind: (typeof IANA_REGISTRIES)[number]["kind"]): Triple | undefined {
  if (kind === "protocol") {
    const value = xmlField(block, "value");
    const name = xmlField(block, "name");
    if (!/^\d+$/.test(value) || !name || SKIP_NAME.test(name)) return undefined;
    return { s: `IANA protocol ${value}`, p: "is", o: name.slice(0, 72), e: "" };
  }
  if (kind === "media") {
    const template = (xmlAttrField(block, "file", "type", "template") || xmlField(block, "file")).toLowerCase();
    const name = xmlField(block, "name");
    if (!template || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(template)) return undefined;
    const sub = template.split("/")[1] || "";
    const redundant = !name || name.toLowerCase() === sub;
    const o = (redundant ? MEDIA_SUBTYPE_OBJECT[sub] || template : name).slice(0, 72);
    if (o.length < 2) return undefined;
    return { s: `IANA media ${template}`, p: "is", o, e: "" };
  }
  if (kind === "scheme") {
    const value = xmlField(block, "value").toLowerCase();
    const status = xmlField(block, "status");
    const desc = xmlField(block, "description");
    if (!/^[a-z][a-z0-9+.-]*$/.test(value)) return undefined;
    if (status && /historic/i.test(status)) return undefined;
    const o = (desc || status || value).slice(0, 72);
    if (o.length < 3) return undefined;
    return { s: `IANA scheme ${value}`, p: "is", o, e: "" };
  }
  if (kind === "method") {
    const value = (xmlField(block, "value") || xmlField(block, "name")).toUpperCase();
    const desc = xmlField(block, "description") || xmlField(block, "details");
    if (!/^[A-Z][A-Z0-9-]{0,24}$/.test(value) || SKIP_NAME.test(value) || SKIP_NAME.test(desc)) return undefined;
    const bits: string[] = [];
    const safe = xmlField(block, "safe").toLowerCase();
    const idem = xmlField(block, "idempotent").toLowerCase();
    if (safe === "yes") bits.push("safe");
    else if (safe === "no") bits.push("unsafe");
    if (idem === "yes") bits.push("idempotent");
    const xref = xmlAttr(block, "xref", "data");
    const rfc = /^rfc(\d{1,5})$/i.exec(xref);
    if (rfc) bits.push(`RFC ${rfc[1]}`);
    const o = (desc || bits.join(", ") || value).slice(0, 72);
    return { s: `IANA method ${value}`, p: "is", o, e: "" };
  }
  if (kind === "rel") {
    const value = xmlField(block, "value").toLowerCase();
    const desc = xmlField(block, "description");
    if (!/^[a-z][a-z0-9.-]{1,40}$/.test(value) || SKIP_NAME.test(value)) return undefined;
    const o = (desc || value).slice(0, 72);
    if (o.length < 3) return undefined;
    return { s: `IANA rel ${value}`, p: "is", o, e: "" };
  }
  if (kind === "wellknown") {
    const value = xmlField(block, "value").toLowerCase();
    const desc = xmlField(block, "description");
    const controller = xmlField(block, "controller");
    if (!/^[a-z0-9][a-z0-9._-]{1,48}$/.test(value)) return undefined;
    const o = (desc || controller || value).slice(0, 72);
    if (o.length < 3) return undefined;
    return { s: `IANA well-known ${value}`, p: "is", o, e: "" };
  }
  if (kind === "charset") {
    const name = (
      xmlField(block, "name") ||
      xmlField(block, "value") ||
      xmlField(block, "preferred_alias")
    ).toLowerCase();
    const pref = xmlField(block, "preferred_alias").toLowerCase() || name;
    if (!CHARSET_KEEP.test(pref) && !CHARSET_KEEP.test(name)) return undefined;
    const key = (pref || name).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:+-]{1,40}$/.test(key) || SKIP_NAME.test(key)) return undefined;
    return { s: `IANA charset ${key}`, p: "is", o: (xmlField(block, "name") || key).slice(0, 72), e: "" };
  }
  if (kind === "header") {
    const value = xmlField(block, "name") || xmlField(block, "value");
    const status = xmlField(block, "status");
    const desc = xmlField(block, "description") || xmlField(block, "remarks");
    if (!/^[A-Za-z][A-Za-z0-9-]{1,40}$/.test(value) || /obsolete|deprecated/i.test(status)) return undefined;
    const xref = xmlAttr(block, "xref", "data");
    const rfc = /^rfc(\d{1,5})$/i.exec(xref);
    const xrefText = xmlField(block, "xref");
    const rfcText = /rfc\s*(\d{1,5})/i.exec(xrefText);
    const useful = desc && !/^(permanent|provisional|deprecated)$/i.test(desc) && desc.length >= 3;
    const o = (useful ? desc : rfc ? `RFC ${rfc[1]}` : rfcText ? `RFC ${rfcText[1]}` : "HTTP field").slice(0, 72);
    if (o.length < 3) return undefined;
    return { s: `IANA header ${value}`, p: "is", o, e: "" };
  }
  if (kind === "dns") {
    const typ = (xmlField(block, "type") || xmlField(block, "name")).toUpperCase();
    const meaning = xmlField(block, "meaning") || xmlField(block, "description");
    if (!/^[A-Z][A-Z0-9-]{0,15}$/.test(typ) || SKIP_NAME.test(typ) || SKIP_NAME.test(meaning)) return undefined;
    const o = (meaning || typ).slice(0, 72);
    if (o.length < 3) return undefined;
    return { s: `IANA dns ${typ}`, p: "is", o, e: "" };
  }
  const value = xmlField(block, "value");
  const desc = xmlField(block, "description");
  if (!/^\d{3}$/.test(value) || !desc || SKIP_NAME.test(desc)) return undefined;
  return { s: `IANA http ${value}`, p: "is", o: desc.slice(0, 72), e: "" };
}

/** Incremental XML scan: keep one open <record> in the carry buffer. */
export function makeIanaXmlParser(kind: (typeof IANA_REGISTRIES)[number]["kind"]) {
  let carry = "";
  const out: Triple[] = [];
  const push = (chunk: string) => {
    carry += chunk;
    for (;;) {
      const end = carry.indexOf("</record>");
      if (end < 0) {
        if (carry.length > 800_000) {
          const keep = carry.lastIndexOf("<record");
          carry = keep >= 0 ? carry.slice(keep) : carry.slice(-4_000);
        }
        return;
      }
      const start = carry.lastIndexOf("<record", end);
      if (start >= 0) {
        const inner = carry.slice(start, end);
        const open = inner.indexOf(">");
        const t = parseIanaRecord(open >= 0 ? inner.slice(open + 1) : inner, kind);
        if (t) out.push(t);
      }
      carry = carry.slice(end + 9);
    }
  };
  return { push, finish: () => out };
}

export function parseIanaXml(xml: string, kind: (typeof IANA_REGISTRIES)[number]["kind"]): Triple[] {
  const p = makeIanaXmlParser(kind);
  const step = 64 * 1024;
  for (let i = 0; i < xml.length; i += step) p.push(xml.slice(i, i + step));
  return p.finish();
}
