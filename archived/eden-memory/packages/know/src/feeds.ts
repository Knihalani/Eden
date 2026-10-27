/** RSS 2.0 / Atom 1.0 link harvest. Recency window, not a site map. */
export function feedLinks(xml: string, cap = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const href = raw.trim().replace(/&amp;/g, "&");
    if (!/^https?:\/\//i.test(href) || seen.has(href) || out.length >= cap) return;
    seen.add(href);
    out.push(href);
  };
  const href = /<link[^>]*\shref=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = href.exec(xml))) push(m[1]!);
  const rss = /<(?:link|guid|id)(?:\s[^>]*)?>\s*(https?:\/\/[^<\s]+)\s*<\/(?:link|guid|id)>/gi;
  while ((m = rss.exec(xml))) push(m[1]!);
  return out;
}
