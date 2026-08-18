export type ParsedCli = {
  family: string;
  subcommand: string;
  flags: string[];
  positionals: string[];
  rewrite_host?: string;
};

const NAMED: Record<string, { subs: string[]; rewrite?: string }> = {
  gh: { subs: ["api", "pr", "issue", "repo", "run", "auth"], rewrite: "api.github.com" },
  pnpm: { subs: ["test", "lint", "build", "install"] },
  npm: { subs: ["test", "lint", "build", "install"] },
  yarn: { subs: ["test", "lint", "build"] },
  curl: { subs: [], rewrite: "curl" },
};

const GENERIC = new Set([
  "ls",
  "cat",
  "cd",
  "pwd",
  "echo",
  "head",
  "tail",
  "true",
  "false",
  "sleep",
  "which",
  "env",
]);

export function parseNamedCli(command: string): ParsedCli | null {
  const parts = tokenize(command);
  if (parts.length === 0) return null;
  const bin = parts[0]!.replace(/.*\//, "");
  if (GENERIC.has(bin)) return null;
  if (bin === "curl") {
    const url = parts.find((p) => /^https?:\/\//.test(p));
    let host: string | undefined;
    try {
      if (url) host = new URL(url).host;
    } catch {
      host = undefined;
    }
    const flags = parts.filter((p) => p.startsWith("-")).map((p) => p.split("=")[0]!);
    return { family: "curl", subcommand: "get", flags: unique(flags), positionals: [], rewrite_host: host };
  }
  const spec = NAMED[bin];
  if (!spec) return null;
  const rest = parts.slice(1).filter((p) => p !== "--");
  const flags = rest.filter((p) => p.startsWith("-")).map((p) => p.split("=")[0]!);
  const positionals = rest.filter((p) => !p.startsWith("-"));
  if (bin === "git") return null;
  if (bin === "gh") {
    const verb = positionals[0];
    if (!verb || !spec.subs.includes(verb)) return null;
    if (verb === "api") {
      return {
        family: "gh",
        subcommand: "api",
        flags: unique(flags),
        positionals: positionals.slice(1),
        rewrite_host: spec.rewrite,
      };
    }
    const sub = positionals.slice(0, 2).join(".") || "api";
    const cloud = /^(pr|issue|run)\b/.test(sub);
    return {
      family: "gh",
      subcommand: sub,
      flags: unique(flags),
      positionals: positionals.slice(2),
      rewrite_host: cloud ? spec.rewrite : undefined,
    };
  }
  const sub = positionals[0] || "run";
  if (spec.subs.length && !spec.subs.includes(sub)) return null;
  return { family: bin, subcommand: sub, flags: unique(flags), positionals: positionals.slice(1) };
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

function demacro(s: string): string {
  return s.replace(/\$\{?sha\}?/gi, "abcde12345").replace(/\$\{?[A-Za-z_][\w]*\}?/g, "12");
}

function tokenize(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

export function familyId(parsed: ParsedCli): string {
  return `${parsed.family}.${parsed.subcommand}`;
}

/** Pull `gh api` / curl URLs out of for-loops and compound bash. */
export function extractNamedCliCalls(command: string): ParsedCli[] {
  const found: ParsedCli[] = [];
  const seen = new Set<string>();
  const push = (p: ParsedCli | null) => {
    if (!p) return;
    const key = `${p.family}.${p.subcommand}:${p.positionals[0] || ""}:${p.rewrite_host || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(p);
  };
  const ghApi = /gh\s+api\s+(?:"([^"]+)"|'([^']+)'|([^\s"'\\]+))/g;
  for (const m of command.matchAll(ghApi)) {
    const path = demacro(m[1] || m[2] || m[3] || "");
    if (!path) continue;
    push(parseNamedCli(`gh api ${path}`));
  }
  const curls = /https?:\/\/[^\s"'\\]+/g;
  if (/\bcurl\b/.test(command)) {
    for (const m of command.matchAll(curls)) {
      const url = demacro(m[0]);
      push(parseNamedCli(`curl ${url}`));
    }
  }
  const ghVerb = /gh\s+(pr|issue|run)\s+(view|list|checks|status)\s+([^\s"'\\]+)?/g;
  for (const m of command.matchAll(ghVerb)) {
    const rest = demacro(m[3] || "12");
    push(parseNamedCli(`gh ${m[1]} ${m[2]} ${rest}`));
  }
  if (found.length) return found;
  const whole = parseNamedCli(command);
  return whole ? [whole] : [];
}
/** HTTP verbs that change something on the far side. */
const WRITE_VERB = "POST|PATCH|PUT|DELETE";

/**
 * `--method VERB`, `--method=VERB`, `-X VERB`, `-XVERB`.
 *
 * The whitespace-only form missed `gh api --method=DELETE …`, a perfectly
 * ordinary spelling, and this predicate is the sole mutation gate for
 * planFromBash, rewriteBash, addJqToCommand and parallelizeSequentialGh — so a
 * false negative here gets a DELETE backgrounded, parallelised, or fitted with
 * a --jq filter.
 */
const METHOD_FLAG = new RegExp(String.raw`(?:^|\s)-{1,2}(?:method|X)[=\s]*(${WRITE_VERB})\b`, "i");

/** Flags that carry a request body, which implies a write even with no verb. */
const BODY_FLAG = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:[=\s]|$)/;

export function isMutatingGh(command: string): boolean {
  if (METHOD_FLAG.test(command)) return true;
  if (/\bgh\s+api\s+graphql\b/.test(command)) return /\bmutation\s*\{/.test(command);
  return /\bgh\s+api\b/.test(command) && BODY_FLAG.test(command);
}

/** curl body-carrying flags. Any of these means a write, whatever the verb. */
const CURL_BODY_FLAG =
  /(?:^|\s)(?:-d|--data|--data-raw|--data-binary|--data-urlencode|--data-ascii|-F|--form|-T|--upload-file)(?:[=\s]|$)/;

/**
 * Does this curl invocation change anything?
 *
 * parseNamedCli hardcodes `subcommand: "get"` for every curl and never looks
 * at the verb, so `curl -X POST https://api.stripe.com/v1/charges` was being
 * treated as a read — reorderable, and worse, deduplicated against an
 * identical sibling so that two charges compiled down to one.
 */
export function isMutatingCurl(command: string): boolean {
  const m = command.match(new RegExp(String.raw`(?:^|\s)-{1,2}(?:request|X)[=\s]*([A-Za-z]+)`, "i"));
  if (m) return new RegExp(`^(?:${WRITE_VERB})$`, "i").test(m[1]!);
  // No explicit verb: curl sends GET unless a body is attached, which makes it
  // a POST.
  return CURL_BODY_FLAG.test(command);
}

