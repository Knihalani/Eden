import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isCompilableToolName } from "./islands";
import { isMutatingGh } from "./named-cli";

export function parseIssueList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return [...new Set(String(raw).split(/[,\s]+/).filter((x) => /^\d+$/.test(x)))];
}

export function extractLoopIds(command: string): string[] {
  const forIds = command.match(/for\s+\w+\s+in\s+([\d\s]+)/);
  if (forIds) {
    const ids = forIds[1]!.trim().split(/\s+/).filter((n) => /^\d+$/.test(n));
    if (ids.length) return ids;
  }
  const fromPaths = [...command.matchAll(/\/(?:pulls|issues)\/(\d+)/g)].map((m) => m[1]!);
  return [...new Set(fromPaths)];
}

export function extractGhRepo(command: string): string | undefined {
  const rest = command.match(/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  if (rest) return rest[1];
  const flag = command.match(/--repo\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  if (flag) return flag[1];
  const gql = command.match(
    /owner:\s*["']([A-Za-z0-9_.-]+)["'][\s\S]{0,120}name:\s*["']([A-Za-z0-9_.-]+)["']/,
  );
  if (gql) return `${gql[1]}/${gql[2]}`;
  if (process.env.EDEN_GH_OWNER && process.env.EDEN_GH_REPO) {
    return `${process.env.EDEN_GH_OWNER}/${process.env.EDEN_GH_REPO}`;
  }
  return undefined;
}

export type TypedPrRow = {
  number: number;
  title: string;
  reviews: number;
  status: string;
  files?: number;
  sha?: string;
};

export type FulfillPlan = {
  repo: string;
  ids: string[];
  pull: boolean;
  reviews: boolean;
  status: boolean;
  files: boolean;
  pullOut?: string;
  reviewsOut?: string;
  statusOut?: string;
  filesOut?: string;
};

export function typedTable(rows: TypedPrRow[]): string {
  return rows
    .map((r) => {
      const bits: Array<string | number> = [r.number, r.title, r.reviews, r.status];
      if (r.files != null) bits.push(r.files);
      if (r.sha) bits.push(r.sha);
      return bits.join(" | ");
    })
    .join("\n");
}

function destFromLine(line: string): string | undefined {
  const m = line.match(/>(?!&)\s*['"]?([^\s'";|&]+)/);
  return m?.[1];
}

function varsFromCommand(command: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of command.matchAll(/(?:^|[\n;\s])([A-Za-z_][A-Za-z0-9_]*)=([^\s;]+)/g)) {
    out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

function expandVars(s: string, vars: Record<string, string>): string {
  let out = s;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`$${k}`, v).replaceAll(`\${${k}}`, v);
  }
  return out;
}

function destHasUnknownVar(s: string): boolean {
  return /\$\{?[A-Za-z_]/.test(s.replaceAll("$n", "").replaceAll("${n}", "").replaceAll("$N", ""));
}

export function planFromBash(command: string): FulfillPlan | null {
  if (isMutatingGh(command)) return null;
  const ids = extractLoopIds(command);
  if (ids.length < 2) return null;
  const repo = extractGhRepo(command);
  if (!repo) return null;
  if (!/\bgh\s+api\b/.test(command) && !/api\.github\.com/.test(command) && !/\bgh\s+pr\s+view\b/.test(command)) {
    return null;
  }
  const gql = /\bgh\s+api\s+graphql\b/.test(command);
  const pull = /\/pulls\/|\/issues\/|pullRequest|\bgh\s+pr\s+view\b/.test(command) || gql;
  const reviews = /\/reviews|reviewThreads|reviews\s*\(|reviews\s*\{/.test(command) || gql;
  const status = /\/status|statusCheckRollup|checkSuites/.test(command) || gql;
  const files = /\/files|files\s*\{|changedFiles/.test(command);
  if (!pull && !reviews && !status && !files) return null;
  const plan: FulfillPlan = { repo, ids, pull: pull || reviews || status, reviews, status, files };
  if (gql && />/.test(command)) return null;
  if (gql) return plan;
  const vars = varsFromCommand(command);
  for (const line of command.split(/\n|;/)) {
    const dest = destFromLine(line.trim());
    if (!dest) continue;
    const expanded = expandVars(dest, vars);
    if (destHasUnknownVar(expanded)) return null;
    if (/\/reviews/.test(line)) plan.reviewsOut = expanded;
    else if (/\/files/.test(line)) plan.filesOut = expanded;
    else if (/\/status/.test(line)) plan.statusOut = expanded;
    else if (/\/pulls\/|\/issues\//.test(line)) plan.pullOut = expanded;
  }
  return plan;
}

function shq(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export function fulfillArgv(plan: FulfillPlan, bin: string): string {
  const parts = [bin, `--repo ${shq(plan.repo)}`, `--ids ${plan.ids.join(",")}`];
  if (plan.pull) parts.push("--pull");
  if (plan.reviews) parts.push("--reviews");
  if (plan.status) parts.push("--status");
  if (plan.files) parts.push("--files");
  if (plan.pullOut) parts.push(`--pull-out ${shq(plan.pullOut)}`);
  if (plan.reviewsOut) parts.push(`--reviews-out ${shq(plan.reviewsOut)}`);
  if (plan.statusOut) parts.push(`--status-out ${shq(plan.statusOut)}`);
  if (plan.filesOut) parts.push(`--files-out ${shq(plan.filesOut)}`);
  return parts.join(" ");
}

function subst(template: string, n: string): string {
  return template.replaceAll("$n", n).replaceAll("${n}", n).replaceAll("$N", n);
}

function writeOut(template: string | undefined, n: string, body: unknown): void {
  if (!template) return;
  const path = subst(template, n);
  mkdirSync(dirname(path) === "." ? process.cwd() : dirname(path) || ".", { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
}

export async function runFulfillPlan(
  plan: FulfillPlan,
  getJson: (path: string) => Promise<unknown>,
): Promise<{ table: string; rows: TypedPrRow[] }> {
  const rows = await Promise.all(
    plan.ids.map(async (n) => {
      const pullPath = `repos/${plan.repo}/pulls/${n}`;
      const [pullRaw, reviewsRaw, filesRaw] = await Promise.all([
        plan.pull !== false ? getJson(pullPath) : Promise.resolve({}),
        plan.reviews ? getJson(`${pullPath}/reviews`) : Promise.resolve([]),
        plan.files ? getJson(`${pullPath}/files`) : Promise.resolve([]),
      ]);
      const pull = (pullRaw || {}) as Record<string, unknown>;
      const reviews = Array.isArray(reviewsRaw) ? reviewsRaw : [];
      const files = Array.isArray(filesRaw) ? filesRaw : [];
      writeOut(plan.pullOut, n, pull);
      writeOut(plan.reviewsOut, n, reviews);
      writeOut(plan.filesOut, n, files);
      let status: Record<string, unknown> = {};
      const sha = String((pull.head as { sha?: string } | undefined)?.sha || "");
      if (sha) {
        status = ((await getJson(`repos/${plan.repo}/commits/${sha}/status`)) || {}) as Record<string, unknown>;
        writeOut(plan.statusOut, n, status);
      }
      const row: TypedPrRow = {
        number: Number(pull.number ?? n),
        title: String(pull.title ?? ""),
        reviews: reviews.length,
        status: String(status.state ?? ""),
        files: files.length,
        sha: sha || undefined,
      };
      return row;
    }),
  );
  // No sort. `Promise.all(plan.ids.map(...))` already resolves in input order,
  // so this was at best a no-op — and not a free one. `a.number` comes from
  // `Number(pull.number ?? n)`, so whenever the API returned a number that
  // differs from the id we asked for, or the id had a leading zero ("007"
  // becomes "7"), indexOf returned -1 and those rows jumped to the front of a
  // table whose whole purpose is to line up with the ids requested. It was
  // also quadratic, doing a linear scan inside the comparator.
  return { table: typedTable(rows), rows };
}

export const MCP_LIST_LIMIT = 6;
export const MCP_DESC_CHARS = 140;

function isHiddenWhenBundle(name: string): boolean {
  if (name.startsWith("github_pr_bundle")) return false;
  return name.startsWith("github_pr") || name.startsWith("github_commit_status") || name === "fetch_issue_bundle";
}

export function selectMcpTools<T extends { name: string; uses_count?: number | null }>(tools: T[], limit = MCP_LIST_LIMIT): T[] {
  let ranked = [...tools].sort(
    (a, b) => (Number(b.uses_count) || 0) - (Number(a.uses_count) || 0) || a.name.localeCompare(b.name),
  );
  if (ranked.some((t) => t.name.startsWith("github_pr_bundle"))) {
    ranked = ranked.filter((t) => !isHiddenWhenBundle(t.name));
    const bundles = ranked.filter((t) => t.name.startsWith("github_pr_bundle"));
    if (bundles.length > 1) {
      const keep = bundles[0]!.name;
      ranked = ranked.filter((t) => !t.name.startsWith("github_pr_bundle") || t.name === keep);
    }
  }
  ranked = ranked.filter((t) => isCompilableToolName(t.name));
  // `ranked` is already sorted by uses_count descending, so the top `limit`
  // are the used ones followed by the best of the rest. Filtering to *only*
  // the used tools left the remaining slots empty — ten compiled tools of
  // which one had ever been used returned one tool, not six — and a freshly
  // compiled tool could then never be surfaced, because it has no uses and
  // some other tool always does. A cold-start trap that closes behind itself.
  return ranked.slice(0, limit);
}

export function shortenWhenToUse(s: string, n = MCP_DESC_CHARS): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** Keeps the hint bounded: it is prepended to a system prompt, not read by a human. */
export const MCP_INSTRUCTIONS_CHARS = 1200;

/**
 * The server-level hint returned from `initialize`.
 *
 * MCP's InitializeResult carries an optional `instructions` string that clients
 * MAY add to the system prompt — the protocol's own channel for telling a model
 * how to use a server. Eden returned nothing there, which mattered more than it
 * sounds: with no CLI hook and no LLM proxy in front of it, a hosted Eden had
 * no mechanism at all for getting its compiled tool called except a 140-char
 * tool description competing against the model's habit of writing the loop by
 * hand.
 *
 * Two things are said deliberately:
 *
 *  - what each tool *replaces*, since a compiled tool is only worth calling if
 *    the model connects it to the loop it was about to write;
 *  - what to do with partial coverage. In the recorded product benchmark the
 *    compiled tool returned 3 of the 5 fields the task needed, and the agent
 *    responded by re-running the entire per-item loop, so the tool cost a call
 *    and saved nothing. "Use it for what it covers and fetch only the rest" is
 *    aimed squarely at that.
 */
export function mcpInstructions(
  tools: Array<{ name: string; when_to_use?: string | null }>,
  limit = MCP_INSTRUCTIONS_CHARS,
): string {
  if (!tools.length) {
    return [
      "Eden compiles tool sequences this workspace repeats into single calls.",
      "None are live yet, so there is nothing here to prefer over your usual approach.",
    ].join(" ");
  }
  const lines = [
    "Eden hosts tools compiled from call sequences this workspace has already run by hand.",
    "Each one replaces a fixed loop of API or CLI calls with a single call returning the same facts.",
    "",
    "Live now:",
  ];
  for (const t of tools) {
    const hint = shortenWhenToUse(t.when_to_use || t.name, 100);
    lines.push(`- ${t.name}: ${hint}`);
  }
  lines.push(
    "",
    "When a task needs the same fields for several ids, call the Eden tool once with all the ids",
    "rather than looping per id. If it does not return every field you need, still use it for the",
    "fields it does return and fetch only the remainder — do not re-run the whole loop.",
  );
  const text = lines.join("\n");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

// Mutation detection lives with the CLI parsing it inspects, so that islands.ts
// can reach it without importing this module (which imports islands.ts).
export { isMutatingGh, isMutatingCurl } from "./named-cli";
