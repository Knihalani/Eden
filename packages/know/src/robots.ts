/**
 * RFC 9309: matching UA groups combined; longest Allow/Disallow wins.
 * `*` and `$` in paths (section 2.2.3). Empty Disallow allows.
 * Specific User-agent groups beat `*`. Crawl-delay and Sitemap are parsed
 * but not in the RFC ABNF.
 */

type Group = { uas: string[]; rules: { allow: boolean; prefix: string }[]; delay?: number };

function parseGroups(robotsTxt: string): Group[] {
  const lines = robotsTxt
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
  const groups: Group[] = [];
  let cur: Group | undefined;
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const v = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!cur || cur.rules.length || cur.delay != null) {
        cur = { uas: [], rules: [] };
        groups.push(cur);
      }
      cur.uas.push(v.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && cur) {
      cur.rules.push({ allow: key === "allow", prefix: v });
    } else if (key === "crawl-delay" && cur) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) cur.delay = n;
    }
  }
  return groups;
}

/** Longest specific product-token prefix; otherwise the `*` groups. */
function matchedGroups(robotsTxt: string, ua: string): Group[] {
  const uaL = ua.toLowerCase();
  const groups = parseGroups(robotsTxt);
  let best = 0;
  for (const g of groups) {
    for (const u of g.uas) {
      if (u === "*" || u.length < 2) continue;
      if (uaL === u || uaL.startsWith(`${u}/`) || uaL.startsWith(u)) best = Math.max(best, u.length);
    }
  }
  if (best > 0) {
    return groups.filter((g) =>
      g.uas.some((u) => u !== "*" && u.length === best && (uaL === u || uaL.startsWith(`${u}/`) || uaL.startsWith(u))),
    );
  }
  return groups.filter((g) => g.uas.some((u) => u === "*"));
}

/** Decode percent-encoded unreserved octets (RFC 9309 §2.2.2). Keep reserved encoded. */
export function robotsDecodePath(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (all, h) => {
    const n = parseInt(h, 16);
    if (!Number.isFinite(n)) return all;
    const c = String.fromCharCode(n);
    return /[A-Za-z0-9\-._~]/.test(c) ? c : all;
  });
}

function escapeRe(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** RFC 9309 path match: prefix, plus `*` (any run) and `$` (end). */
export function robotsPathMatches(pattern: string, path: string): boolean {
  if (pattern === "/") return true;
  const pat = robotsDecodePath(pattern);
  const p = robotsDecodePath(path);
  if (!pat.includes("*") && !pat.includes("$")) return p.startsWith(pat);
  let body = pat;
  let end = false;
  if (body.endsWith("$")) {
    end = true;
    body = body.slice(0, -1);
  }
  let re = "^";
  for (const ch of body) re += ch === "*" ? ".*" : escapeRe(ch);
  if (end) re += "$";
  try {
    return new RegExp(re).test(p);
  } catch {
    return p.startsWith(pat);
  }
}

export function robotsAllows(robotsTxt: string, ua: string, path: string): boolean {
  const rules = matchedGroups(robotsTxt, ua).flatMap((g) => g.rules);
  if (!rules.length) return true;
  let bestLen = -1;
  let bestAllow = true;
  for (const r of rules) {
    if (r.prefix === "" && !r.allow) continue;
    if (!robotsPathMatches(r.prefix || "/", path)) continue;
    const len = (r.prefix || "/").length;
    if (len > bestLen) {
      bestLen = len;
      bestAllow = r.allow;
    } else if (len === bestLen && r.allow) {
      bestAllow = true;
    }
  }
  return bestAllow;
}

export function robotsCrawlDelaySec(robotsTxt: string, ua: string): number | undefined {
  const delays = matchedGroups(robotsTxt, ua)
    .map((g) => g.delay)
    .filter((n): n is number => n != null);
  return delays.at(-1);
}

export function robotsSitemaps(robotsTxt: string): string[] {
  const out: string[] = [];
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!/^sitemap\s*:/i.test(line)) continue;
    const url = line.slice(line.indexOf(":") + 1).trim();
    if (/^https?:\/\//i.test(url)) out.push(url);
  }
  return out;
}

/** RFC 9309: 5xx / unreachable → complete disallow; 4xx → unrestricted. */
export function robotsTxtForHttpStatus(status: number): string {
  if (status >= 500) return "User-agent: *\nDisallow: /\n";
  return "";
}

export type SitemapUrl = { loc: string; lastmod?: string };

export function parseSitemap(
  xml: string,
  cap = 500,
): { kind: "urlset" | "index" | "unknown"; urls: SitemapUrl[]; children: string[] } {
  const urls: SitemapUrl[] = [];
  const children: string[] = [];
  const childCap = Math.min(cap, 32);
  if (/<sitemapindex[\s>]/i.test(xml)) {
    const block = /<sitemap\b[\s\S]*?<\/sitemap>/gi;
    let m: RegExpExecArray | null;
    while ((m = block.exec(xml)) && children.length < childCap) {
      const loc = m[0]!.match(/<loc>\s*([^<]+)\s*<\/loc>/i)?.[1]?.trim();
      if (loc && /^https?:\/\//i.test(loc)) children.push(loc);
    }
    return { kind: "index", urls: [], children };
  }
  if (/<urlset[\s>]/i.test(xml) || /<url\b/i.test(xml)) {
    const block = /<url\b[\s\S]*?<\/url>/gi;
    let m: RegExpExecArray | null;
    while ((m = block.exec(xml)) && urls.length < cap) {
      const loc = m[0]!.match(/<loc>\s*([^<]+)\s*<\/loc>/i)?.[1]?.trim();
      if (!loc || !/^https?:\/\//i.test(loc)) continue;
      const lastmod = m[0]!.match(/<lastmod>\s*([^<]+)\s*<\/lastmod>/i)?.[1]?.trim();
      urls.push(lastmod ? { loc, lastmod } : { loc });
    }
    return { kind: "urlset", urls, children: [] };
  }
  const re = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && urls.length < cap) {
    const loc = m[1]!.trim();
    if (/^https?:\/\//i.test(loc)) urls.push({ loc });
  }
  return { kind: "unknown", urls, children: [] };
}

export function sitemapLocs(xml: string, cap = 500): string[] {
  const p = parseSitemap(xml, cap);
  if (p.kind === "index") return p.children.slice(0, cap);
  return p.urls.map((u) => u.loc).slice(0, cap);
}
