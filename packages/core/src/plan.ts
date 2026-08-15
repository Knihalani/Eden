import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function parseIssueList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return [...new Set(String(raw).split(/[,\s]+/).filter((x) => /^\d+$/.test(x)))];
}

export function extractLoopIds(command: string): string[] {
  const forIds = command.match(/for\s+\w+\s+in\s+([\d\s]+)/);
  if (forIds) {
    const ids = forIds[1].trim().split(/\s+/).filter((n) => /^\d+$/.test(n));
    if (ids.length) return ids;
  }
  const fromPaths = [...command.matchAll(/\/(?:pulls|issues)\/(\d+)/g)].map((m) => m[1]);
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

export function isMutatingGh(command: string): boolean {
  if (/--method\s+(POST|PATCH|PUT|DELETE)|-X\s+(POST|PATCH|PUT|DELETE)/i.test(command)) return true;
  if (/\bgh\s+api\s+graphql\b/.test(command)) return /\bmutation\s*\{/.test(command);
  return /\bgh\s+api\b[\s\S]*\s-f\s/i.test(command);
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
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
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
        getJson(pullPath),
        getJson(`${pullPath}/reviews`),
        getJson(`${pullPath}/files`),
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
  rows.sort((a, b) => plan.ids.indexOf(String(a.number)) - plan.ids.indexOf(String(b.number)));
  return { table: typedTable(rows), rows };
}

export const MCP_LIST_LIMIT = 3;
export const MCP_DESC_CHARS = 80;

export function selectMcpTools<T extends { name: string; uses_count?: number | null }>(tools: T[], limit = MCP_LIST_LIMIT): T[] {
  let ranked = [...tools].sort(
    (a, b) => (Number(b.uses_count) || 0) - (Number(a.uses_count) || 0) || a.name.localeCompare(b.name),
  );
  if (ranked.some((t) => t.name.startsWith("github_pr_bundle"))) {
    ranked = ranked.filter((t) => !t.name.startsWith("github_pr_files"));
  }
  if (ranked.length <= limit) return ranked;
  const used = ranked.filter((t) => Number(t.uses_count) > 0);
  if (used.length) return used.slice(0, limit);
  return ranked.slice(0, limit);
}

export function shortenWhenToUse(s: string, n = MCP_DESC_CHARS): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
