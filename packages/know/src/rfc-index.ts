/** RFC Editor index → typed `RFC N is <title>` facts. One fetch, thousands of interned triples. */

import { decodeEntities, shortTitle, type Triple } from "./extract";
import { junkRfcTitle, cleanRfcTitle } from "./pack";

export const RFC_INDEX_URL = "https://www.rfc-editor.org/rfc-index.xml";

function decodeXml(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

function entryDocIds(block: string, tag: string): string[] {
  const inner = block.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "i"))?.[0] ?? "";
  return [...inner.matchAll(/<doc-id>\s*RFC0*(\d+)\s*<\/doc-id>/gi)].map((m) => m[1]!);
}

function edgeTriple(s: string, pred: "obsoletes" | "updates", nums: string[]): Triple | undefined {
  const uniq = [...new Set(nums)];
  if (!uniq.length) return undefined;
  let o = "";
  for (const n of uniq) {
    const next = o ? `${o}, RFC ${n}` : `RFC ${n}`;
    if (next.length > 72) break;
    o = next;
  }
  return o ? { s, p: pred, o, e: "" } : undefined;
}

/** Current RFCs only: skip not-issued, historic, and already-obsoleted entries. */
export function parseRfcEntry(block: string): Triple[] {
  const out: Triple[] = [];
  if (/<obsoleted-by>/i.test(block)) return out;
  const status = block.match(/<current-status>\s*([^<]+)\s*<\/current-status>/i)?.[1] ?? "";
  if (/NOT ISSUED|HISTORIC|UNKNOWN/i.test(status)) return out;
  const id = block.match(/<doc-id>\s*RFC0*(\d+)\s*<\/doc-id>/i)?.[1];
  const title = block.match(/<title\b[^>]*>\s*([^<]+)\s*<\/title>/i)?.[1];
  if (!id || !title) return out;
  const o = cleanRfcTitle(shortTitle(decodeXml(title)));
  if (o.length < 8 || junkRfcTitle(o)) return out;
  const s = `RFC ${id}`;
  out.push({ s, p: "is", o, e: "" });
  const obs = edgeTriple(s, "obsoletes", entryDocIds(block, "obsoletes"));
  if (obs) out.push(obs);
  const upd = edgeTriple(s, "updates", entryDocIds(block, "updates"));
  if (upd) out.push(upd);
  return out;
}

/** Incremental XML scan: keep one open <rfc-entry> in the carry buffer, not the whole index. */
export function makeRfcIndexParser() {
  let carry = "";
  const out: Triple[] = [];
  const push = (chunk: string) => {
    carry += chunk;
    for (;;) {
      const end = carry.indexOf("</rfc-entry>");
      if (end < 0) {
        if (carry.length > 1_000_000) {
          const keep = carry.lastIndexOf("<rfc-entry>");
          carry = keep >= 0 ? carry.slice(keep) : carry.slice(-8_000);
        }
        return;
      }
      const start = carry.lastIndexOf("<rfc-entry>", end);
      if (start >= 0) out.push(...parseRfcEntry(carry.slice(start, end)));
      carry = carry.slice(end + 12);
    }
  };
  return {
    push,
    finish(): Triple[] {
      return out;
    },
  };
}

export function parseRfcIndex(xml: string): Triple[] {
  const p = makeRfcIndexParser();
  const step = 64 * 1024;
  for (let i = 0; i < xml.length; i += step) p.push(xml.slice(i, i + step));
  return p.finish();
}
