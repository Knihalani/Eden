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
