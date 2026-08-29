/** W3C TR catalog → typed `W3C <shortname> is <title>` facts. Two JSON pages, no HTML dump. */

import { shortTitle, type Triple } from "./extract";

export const W3_CATALOG_URL = "https://api.w3.org/specifications";

type HalLink = { href?: string; title?: string };
type HalPage = {
  _links?: { specifications?: HalLink[] | HalLink; next?: HalLink };
};

function shortnameOf(href: string): string {
  try {
    const path = new URL(href).pathname.replace(/\/+$/, "");
    return path.split("/").pop() || "";
  } catch {
    return href.split("/").filter(Boolean).pop() || "";
  }
}

export function parseW3Catalog(pages: unknown[]): Triple[] {
  const out: Triple[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (!page || typeof page !== "object") continue;
    const links = (page as HalPage)._links?.specifications;
    const list = Array.isArray(links) ? links : links ? [links] : [];
    for (const item of list) {
      const href = item.href || "";
      const slug = shortnameOf(href);
      if (!slug || seen.has(slug)) continue;
      const o = shortTitle((item.title || slug.replace(/-/g, " ")).replace(/\s+/g, " ").trim());
      if (o.length < 8) continue;
      seen.add(slug);
      out.push({ s: `W3C ${slug}`, p: "is", o, e: "" });
    }
  }
  return out;
}

export function nextW3Page(page: unknown): string | undefined {
  if (!page || typeof page !== "object") return undefined;
  const href = (page as HalPage)._links?.next?.href;
  return href || undefined;
}
