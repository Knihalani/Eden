/**
 * RFC 9309-ish: matching UA groups combined; longest Allow/Disallow prefix wins.
 * Empty Disallow allows. Crawl-delay and Sitemap are parsed but not in the RFC ABNF.
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

function matchedGroups(robotsTxt: string, ua: string): Group[] {
  const uaL = ua.toLowerCase();
  return parseGroups(robotsTxt).filter((g) =>
    g.uas.some((u) => u === "*" || uaL === u || uaL.startsWith(u)),
  );
}

export function robotsAllows(robotsTxt: string, ua: string, path: string): boolean {
  const rules = matchedGroups(robotsTxt, ua).flatMap((g) => g.rules);
  if (!rules.length) return true;
  let bestLen = -1;
  let bestAllow = true;
  for (const r of rules) {
    if (r.prefix === "" && !r.allow) continue;
    if (path.startsWith(r.prefix) || r.prefix === "/") {
      if (r.prefix.length >= bestLen) {
        bestLen = r.prefix.length;
        bestAllow = r.allow;
      }
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

export function sitemapLocs(xml: string, cap = 40): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < cap) {
    const u = m[1]!.trim();
    if (/^https?:\/\//i.test(u)) out.push(u);
  }
  return out;
}
