import { EDENBOT, UA_TOKEN } from "./ua";
import { robotsAllows, robotsCrawlDelaySec, robotsSitemaps, robotsTxtForHttpStatus, sitemapLocs } from "./robots";
import { skipHost } from "./extract";
import { createHash } from "node:crypto";

const robotsCache = new Map<string, { txt: string; at: number }>();
const lastHit = new Map<string, number>();

export async function fetchRobots(origin: string): Promise<string> {
  const hit = robotsCache.get(origin);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.txt;
  try {
    const r = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": EDENBOT },
      signal: AbortSignal.timeout(8000),
    });
    const txt = r.ok ? await r.text() : robotsTxtForHttpStatus(r.status);
    robotsCache.set(origin, { txt, at: Date.now() });
    return txt;
  } catch {
    robotsCache.set(origin, { txt: robotsTxtForHttpStatus(503), at: Date.now() });
    return robotsTxtForHttpStatus(503);
  }
}

async function prepareLive(
  url: string,
  opts?: { timeoutMs?: number; accept?: string },
): Promise<
  | { ok: true; parsed: URL; headers: Record<string, string>; timeoutMs: number }
  | { ok: false; status: number; html: string; skip: string; chars: number; digest: string }
> {
  const blocked = skipHost(url);
  const empty = { ok: false as const, status: 0, html: "", chars: 0, digest: "" };
  if (blocked) return { ...empty, skip: blocked };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ...empty, skip: "bad-url" };
  }
  const robots = await fetchRobots(parsed.origin);
  if (robots && !robotsAllows(robots, UA_TOKEN, parsed.pathname || "/")) {
    return { ...empty, skip: "robots" };
  }
  const delay = robotsCrawlDelaySec(robots, UA_TOKEN) ?? 1;
  const last = lastHit.get(parsed.host) ?? 0;
  const wait = delay * 1000 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 15_000)));
  lastHit.set(parsed.host, Date.now());
  return {
    ok: true,
    parsed,
    headers: {
      "User-Agent": EDENBOT,
      Accept: opts?.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
    },
    timeoutMs: opts?.timeoutMs ?? 12_000,
  };
}

export async function liveGetStream(
  url: string,
  opts?: { timeoutMs?: number; accept?: string; onChunk?: (s: string) => void },
): Promise<{
  ok: boolean;
  status: number;
  html: string;
  chars: number;
  digest: string;
  skip?: string;
}> {
  const pre = await prepareLive(url, opts);
  if (!pre.ok) return pre;
  try {
    const r = await fetch(url, {
      headers: pre.headers,
      signal: AbortSignal.timeout(pre.timeoutMs),
      redirect: "follow",
    });
    if (!r.ok) return { ok: false, status: r.status, html: "", chars: 0, digest: "", skip: `http-${r.status}` };
    const h = createHash("sha256");
    let chars = 0;
    const onChunk = opts?.onChunk;
    const reader = r.body?.getReader();
    if (!reader) {
      const html = await r.text();
      h.update(html);
      onChunk?.(html);
      return { ok: true, status: r.status, html: "", chars: html.length, digest: h.digest("hex").slice(0, 16) };
    }
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      if (!s) continue;
      h.update(s);
      chars += s.length;
      onChunk?.(s);
    }
    const tail = dec.decode();
    if (tail) {
      h.update(tail);
      chars += tail.length;
      onChunk?.(tail);
    }
    return { ok: true, status: r.status, html: "", chars, digest: h.digest("hex").slice(0, 16) };
  } catch (e) {
    return { ok: false, status: 0, html: "", chars: 0, digest: "", skip: String(e).slice(0, 80) };
  }
}

export async function liveGet(
  url: string,
  opts?: { timeoutMs?: number; accept?: string },
): Promise<{
  ok: boolean;
  status: number;
  html: string;
  skip?: string;
}> {
  const pre = await prepareLive(url, opts);
  if (!pre.ok) return { ok: false, status: pre.status, html: "", skip: pre.skip };
  try {
    const r = await fetch(url, {
      headers: pre.headers,
      signal: AbortSignal.timeout(pre.timeoutMs),
      redirect: "follow",
    });
    const html = await r.text();
    if (!r.ok) return { ok: false, status: r.status, html: "", skip: `http-${r.status}` };
    return { ok: true, status: r.status, html };
  } catch (e) {
    return { ok: false, status: 0, html: "", skip: String(e).slice(0, 80) };
  }
}

export async function sitemapFrontier(origin: string): Promise<string[]> {
  const robots = await fetchRobots(origin);
  const maps = robotsSitemaps(robots).slice(0, 2);
  const urls: string[] = [];
  for (const sm of maps) {
    const got = await liveGet(sm);
    if (!got.ok) continue;
    urls.push(...sitemapLocs(got.html, 40));
  }
  return urls.filter((u) => !skipHost(u));
}
