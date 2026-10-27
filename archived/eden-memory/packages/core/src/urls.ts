import type { ParsedCli } from "./named-cli";

const SKIP_SEGS = new Set(["forge", "repos", "v1", "v2", "api", "rest", "graphql"]);

function demacroPath(s: string): string {
  // The substitution has to agree with the mine side. `${sha}`-shaped macros
  // stand in for commit hashes, which parameterizeUrl only recognizes at 5+
  // hex characters — substituting "12" made a re-run command never match a
  // tool compiled from a recorded /commits/{sha} shape. Numeric-looking
  // macros keep the short substitute the issue/pull shapes expect.
  return s.replace(/\$\{?[A-Za-z_][\w]*\}?/g, (m) => {
    const name = m
      .replace(/^\$\{?/, "")
      .replace(/\}$/, "")
      .toLowerCase();
    return /sha|commit|hash|digest|rev/.test(name) ? "abcde12345" : "12";
  });
}

/** Turn recorded SaaS URLs into playback templates. GitHub keeps {issue}/{sha}; everything else gets {id}. */
export function parameterizeUrl(url: string): string {
  let out = url
    .replace(/\/issues\/\d+/gi, "/issues/{issue}")
    .replace(/\/pulls\/\d+/gi, "/pulls/{issue}")
    .replace(/\/pull\/\d+/gi, "/pull/{issue}")
    .replace(/[?&]pr=\d+/gi, (m) => m.replace(/\d+/, "{issue}"))
    .replace(/\/commits\/[A-Fa-f0-9]{5,}/g, "/commits/{sha}")
    .replace(/\/runs\/\d+/gi, "/runs/{run_id}");
  let n = 0;
  // A segment is finished by `/`, the query, OR a fragment: /orders/5#top is
  // the order with id 5, not an opaque path.
  out = out.replace(/\/(\d+)(?=\/|#|$|\?)/g, () => {
    n += 1;
    return n === 1 ? "/{id}" : `/{id${n}}`;
  });
  return out;
}

export function templateKeys(urls: string[]): string[] {
  const keys = new Set<string>();
  for (const u of urls) {
    for (const m of u.matchAll(/\{(\w+)\}/g)) {
      const key = m[1];
      if (key && key !== "origin") keys.add(key);
    }
  }
  return [...keys];
}

export function hostSlug(host: string): string | null {
  const h = host.replace(/:\d+$/, "").replace(/^www\./, "");
  if (!h || h === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("127.")) return null;
  const parts = h.split(".");
  const raw = parts[0] === "api" && parts[1] ? parts[1] : parts[0]!;
  const slug = raw.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  return slug || null;
}

function splitUrl(url: string): { host: string; pathname: string } | null {
  const m = url.match(/^(https?:\/\/)([^/?#]+)([^?#]*)/i);
  if (!m) return null;
  return { host: m[2]!, pathname: m[3] || "/" };
}

export function pathResource(pathname: string): string {
  // Keep identifier-shaped segments visible during the walk: numbers, hashes,
  // templated slots and capitalised slugs are exactly where REST paths pivot
  // from scoping to the resource (`/repos/{owner}/{repo}/pulls/{id}/reviews`).
  const segs = pathname
    .split("/")
    .filter(Boolean)
    .filter((s) => {
      if (s.startsWith("%7B") || s.startsWith("%7b")) return false;
      if (SKIP_SEGS.has(s.toLowerCase())) return false;
      return true;
    });
  const isIdent = (s: string) =>
    s.startsWith("{") ||
    /^\d+$/.test(s) ||
    /^[a-f0-9]{6,}$/i.test(s) ||
    /^[A-Z][a-zA-Z0-9_]*$/.test(s) ||
    // Prefixed entity ids: in_123, cus_8kQ2, order-8891 — a short type tag
    // followed by digits is an identifier in essentially every SaaS API.
    /^[a-z]{2,8}[-_]\d[\w-]*$/i.test(s);
  let lastIdent = -1;
  for (let i = 0; i < segs.length; i++) {
    if (isIdent(segs[i]!)) lastIdent = i;
  }
  let picked: string[];
  if (lastIdent >= 0 && lastIdent < segs.length - 1) {
    picked = segs.slice(lastIdent + 1);
  } else {
    // No trailing resource after the last identifier — the identifier's
    // *container* is the resource (/posts/1 → posts).
    picked = lastIdent > 0 ? [segs[lastIdent - 1]!] : segs.slice(0, 1);
  }
  const joined = picked
    .slice(0, 2)
    .join("_")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_|_$/g, "");
  return joined || "resource";
}

export function toolNameFromUrls(urls: string[]): string | null {
  const usable = urls.filter(Boolean);
  if (!usable.length) return null;
  let host: string | null = null;
  const seen = new Set<string>();
  const resources: string[] = [];
  for (const raw of usable) {
    const parts = splitUrl(parameterizeUrl(raw));
    if (!parts) continue;
    host = host || hostSlug(parts.host);
    const r = pathResource(parts.pathname);
    // A chain, not a shortest pick: an island that fetches pulls + reviews +
    // status is named for everything it replaces, which is what makes the
    // name say what the tool *does* without any vendor table.
    if (!seen.has(r)) {
      seen.add(r);
      resources.push(r);
    }
  }
  if (!resources.length) return null;
  const path = resources.join("_");
  const name = host && host !== "github" ? `${host}_${path}` : path;
  return name.slice(0, 48).replace(/^_|_$/g, "") || null;
}

function urlShape(url: string): string {
  const templated = parameterizeUrl(url);
  const parts = splitUrl(templated);
  const raw = parts ? `${parts.host}${parts.pathname}` : templated;
  return raw.replaceAll("{issue}", "{id}").replaceAll("{run_id}", "{id}");
}

/** Pull concrete URLs out of a bash stretch so we can match a compiled tool. */
export function extractCommandUrls(command: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    const cleaned = demacroPath(u).replace(/[\\,;]+$/, "");
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    found.push(cleaned);
  };
  for (const m of command.matchAll(/https?:\/\/[^\s"'\\]+/g)) push(m[0]);
  const ghApi = /gh\s+api\s+(?:"([^"]+)"|'([^']+)'|([^\s"'\\]+))/g;
  for (const m of command.matchAll(ghApi)) {
    const path = m[1] || m[2] || m[3] || "";
    if (!path || path === "graphql") continue;
    if (/^https?:\/\//.test(path)) push(path);
    else push(`https://api.github.com/${path.replace(/^\//, "")}`);
  }
  return found;
}

/** True when a recorded bash stretch is the same HTTP shape as a compiled tool. */
export function commandMatchesToolUrls(command: string, toolUrls: string[]): boolean {
  if (!toolUrls.length) return false;
  const cmd = extractCommandUrls(command).map(urlShape);
  if (!cmd.length) return false;
  const tools = toolUrls.filter(Boolean).map(urlShape);
  // A prefix only counts where a path segment ends. Raw startsWith matched on
  // a shared *character* prefix, so `repos/o/rep` matched a tool compiled for
  // `repos/o/repo-two/pulls/{id}` — steering the agent to a tool that fetches
  // a different repository.
  const prefixAt = (a: string, b: string) => a.startsWith(b) && (a.length === b.length || a[b.length] === "/");
  return cmd.some((c) => tools.some((t) => t === c || prefixAt(t, c) || prefixAt(c, t)));
}

/** Map a named `gh` invocation to the REST URL Eden can play back. */
export function githubRestFromCli(parsed: ParsedCli, command = ""): string | undefined {
  if (parsed.family !== "gh") return undefined;
  if (parsed.subcommand === "api") {
    const path = parsed.positionals[0];
    if (!path || path === "graphql") return undefined;
    if (/^https?:\/\//.test(path)) return path;
    return `https://api.github.com/${path.replace(/^\//, "")}`;
  }
  const flagged = command.match(/--repo[=\s]+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  const envRepo =
    process.env.EDEN_GH_OWNER && process.env.EDEN_GH_REPO
      ? `${process.env.EDEN_GH_OWNER}/${process.env.EDEN_GH_REPO}`
      : "";
  const repo = flagged?.[1] || envRepo;
  if (!repo) return undefined;
  const n = parsed.positionals.find((p) => /^\d+$/.test(p));
  const base = `https://api.github.com/repos/${repo}`;
  if (parsed.subcommand === "pr.view" || parsed.subcommand === "pr.get") {
    return n ? `${base}/pulls/${n}` : undefined;
  }
  if (parsed.subcommand === "issue.view" || parsed.subcommand === "issue.get") {
    return n ? `${base}/issues/${n}` : undefined;
  }
  if (parsed.subcommand === "pr.review" || parsed.subcommand === "pr.reviews") {
    return n ? `${base}/pulls/${n}/reviews` : undefined;
  }
  if (parsed.subcommand === "run.list") return `${base}/actions/runs`;
  return undefined;
}

export function compileStepUrl(step: {
  source_url?: string;
  rewrite_host?: string;
  name?: string;
}): string | undefined {
  if (step.source_url) return parameterizeUrl(step.source_url);
  return undefined;
}

// Mirrors the DANGEROUS set in packages/ir/src/path.ts. Core does not depend
// on @eden/ir, so the guard is copied locally rather than imported — keep the
// two in agreement.
const DANGEROUS_SEG = new Set(["__proto__", "prototype", "constructor"]);

function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const p of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    // `__proto__` walks the prototype chain and `constructor` reaches Function/
    // Object themselves, so a template like {{s1.constructor.name}} interpolated
    // engine internals into a URL. Object.hasOwn keeps inherited properties out
    // for the same reason: only values the prior step actually returned may be
    // bound.
    if (DANGEROUS_SEG.has(p) || !Object.hasOwn(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** `{issue}` from args, `{{s1.number}}` from prior step results. */
export function resolveTemplate(
  template: string,
  params: Record<string, string>,
  results: Record<string, unknown> = {},
): string {
  // Encoded the same way `{param}` is, below. This pass interpolated raw, so
  // a bound value containing `?`, `#`, `&` or a space was spliced unescaped
  // into a URL that playback then hands to `new URL()` — changing which
  // resource is fetched, or which query parameters it carries. A non-scalar
  // became the literal "[object Object]", which is never what was meant, so
  // it contributes nothing rather than a nonsense path segment.
  const withBind = template.replace(/\{\{(\w+)\.([^}]+)\}\}/g, (_, id, path) => {
    const v = getPath(results[id], path);
    if (v == null) return "";
    if (typeof v === "object") return "";
    return encodeURIComponent(String(v));
  });
  return withBind.replace(/\{(\w+)\}/g, (_, k) => {
    if (k === "origin") return params.origin ?? "";
    if (k === "id" || k === "issue") {
      return encodeURIComponent(params[k] || params.id || params.issue || params.pr || params.number || "");
    }
    return encodeURIComponent(params[k] ?? "");
  });
}
