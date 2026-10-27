/** IETF Datatracker related-document edges. Complements RFC index titles; does not re-pack titles. */

import { type Triple } from "./extract";

export const IETF_RELATED_URL = "https://datatracker.ietf.org/api/v1/doc/relateddocument/?format=json&limit=200";

type RelRow = {
  relationship?: string;
  source?: string;
  target?: string;
};

type RelPage = {
  meta?: { next?: string | null };
  objects?: RelRow[];
};

function rfcName(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const m = uri.match(/rfc(\d+)/i);
  return m ? `RFC ${Number(m[1])}` : undefined;
}

/** Fold updates/obs targets per source RFC. Cap four targets, 72 chars. */
export function parseRelatedDocs(pages: unknown[], pred: "updates" | "obsoletes"): Triple[] {
  const bySrc = new Map<string, string[]>();
  for (const page of pages) {
    if (!page || typeof page !== "object") continue;
    const objects = (page as RelPage).objects || [];
    for (const row of objects) {
      const s = rfcName(row.source);
      const o = rfcName(row.target);
      if (!s || !o || s === o) continue;
      const list = bySrc.get(s) || [];
      if (!list.includes(o) && list.length < 4) list.push(o);
      bySrc.set(s, list);
    }
  }
  const out: Triple[] = [];
  for (const [s, targets] of bySrc) {
    const o = targets.join(", ");
    if (o.length > 72) continue;
    out.push({ s, p: pred, o, e: "" });
  }
  return out;
}

export function nextRelatedPage(page: unknown): string | undefined {
  if (!page || typeof page !== "object") return undefined;
  const next = (page as RelPage).meta?.next;
  if (!next) return undefined;
  if (next.startsWith("http")) return next;
  return `https://datatracker.ietf.org${next}`;
}
