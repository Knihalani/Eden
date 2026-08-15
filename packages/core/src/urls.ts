import type { ParsedCli } from "./named-cli";

/** Turn recorded SaaS URLs into playback templates. */
export function parameterizeUrl(url: string): string {
  return url
    .replace(/\/issues\/\d+/gi, "/issues/{issue}")
    .replace(/\/pulls\/\d+/gi, "/pulls/{issue}")
    .replace(/\/pull\/\d+/gi, "/pull/{issue}")
    .replace(/[?&]pr=\d+/gi, (m) => m.replace(/\d+/, "{issue}"))
    .replace(/\/commits\/[A-Fa-f0-9]{5,}/g, "/commits/{sha}")
    .replace(/\/runs\/\d+/gi, "/runs/{run_id}");
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

function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const p of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
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
  const withBind = template.replace(/\{\{(\w+)\.([^}]+)\}\}/g, (_, id, path) => {
    const v = getPath(results[id], path);
    return v == null ? "" : String(v);
  });
  return withBind.replace(/\{(\w+)\}/g, (_, k) => {
    if (k === "origin") return params.origin ?? "";
    return encodeURIComponent(params[k] ?? "");
  });
}
