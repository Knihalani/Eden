import { readConfig, ensureHome } from "./home";
import { compactReceipt, parseIssueList, writePrefetch, extractGhRepo, runFulfillPlan, planFromBash } from "@eden/core";

export async function playCli(args: string[]): Promise<void> {
  ensureHome();
  const name = args[0];
  if (!name) {
    console.error("eden play <tool> --issues 170,169");
    process.exit(1);
  }
  const issuesIdx = args.indexOf("--issues");
  const issueIdx = args.indexOf("--issue");
  const issues = issuesIdx >= 0 ? args[issuesIdx + 1] : issueIdx >= 0 ? args[issueIdx + 1] : args[1];
  const cfg = readConfig();
  const base = cfg?.base_url || process.env.EDEN_BASE_URL || "http://127.0.0.1:8787";
  const key = cfg?.api_key || process.env.EDEN_API_KEY || "eden_dev";
  const res = await fetch(`${base}/v1/play`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ name, issues, issue: String(issues || "").split(/[,\s]+/)[0] }),
  });
  const json = (await res.json()) as { table?: string; facts?: unknown; ok?: boolean };
  const text = json.table || compactReceipt(json.facts) || JSON.stringify(json.facts ?? json);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  if (!res.ok || json.ok === false) process.exit(1);
}

export async function recallCli(args: string[]): Promise<void> {
  const { getVault } = await import("@eden/core");
  const id = args[0];
  if (!id) {
    console.error("eden recall <id>");
    process.exit(1);
  }
  const body = getVault(id);
  if (body == null) {
    console.error("not found");
    process.exit(1);
  }
  process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
}

async function ghJson(path: string): Promise<unknown> {
  const r = Bun.spawn(["gh", "api", path], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(r.stdout).text();
  await r.exited;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function prefetchCli(args: string[]): Promise<void> {
  ensureHome();
  const idsIdx = args.indexOf("--ids");
  const repoIdx = args.indexOf("--repo");
  const ids = parseIssueList(idsIdx >= 0 ? args[idsIdx + 1] : "");
  const repo =
    repoIdx >= 0
      ? args[repoIdx + 1]
      : extractGhRepo(args.join(" ")) ||
        (process.env.EDEN_GH_OWNER && process.env.EDEN_GH_REPO
          ? `${process.env.EDEN_GH_OWNER}/${process.env.EDEN_GH_REPO}`
          : "");
  if (!repo || !ids.length) return;
  await Promise.all(
    ids.map(async (n) => {
      const pull = (await ghJson(`repos/${repo}/pulls/${n}`)) as {
        number?: number;
        title?: string;
        head?: { sha?: string };
      };
      const reviews = await ghJson(`repos/${repo}/pulls/${n}/reviews`);
      const sha = pull.head?.sha;
      const status = sha ? ((await ghJson(`repos/${repo}/commits/${sha}/status`)) as { state?: string }) : {};
      const files = await ghJson(`repos/${repo}/pulls/${n}/files`);
      const line = [
        pull.number ?? n,
        pull.title ?? "",
        Array.isArray(reviews) ? reviews.length : "?",
        status.state ?? "?",
        Array.isArray(files) ? files.length : "?",
      ].join(" | ");
      writePrefetch(`repos/${repo}/pulls/${n}`, line);
      writePrefetch(`repos/${repo}/pulls/${n}/reviews`, String(Array.isArray(reviews) ? reviews.length : 0));
      writePrefetch(`repos/${repo}/pulls/${n}/files`, String(Array.isArray(files) ? files.length : 0));
    }),
  );
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

const jsonCache = new Map<string, { at: number; value: unknown }>();
const CACHE_MS = 120_000;

async function getGithubJson(path: string): Promise<unknown> {
  const hit = jsonCache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await ghJson(path);
  jsonCache.set(path, { at: Date.now(), value });
  return value;
}

export async function fulfillCli(args: string[]): Promise<void> {
  ensureHome();
  const fromCmd = flag(args, "--command");
  const plan = fromCmd
    ? planFromBash(fromCmd)
    : {
        repo: flag(args, "--repo") || "",
        ids: parseIssueList(flag(args, "--ids")),
        pull: has(args, "--pull") || !has(args, "--files"),
        reviews: has(args, "--reviews"),
        status: has(args, "--status"),
        files: has(args, "--files"),
        pullOut: flag(args, "--pull-out"),
        reviewsOut: flag(args, "--reviews-out"),
        statusOut: flag(args, "--status-out"),
        filesOut: flag(args, "--files-out"),
      };
  if (!plan || !plan.repo || !plan.ids.length) {
    console.error("eden fulfill --repo owner/name --ids 170,169 --pull --reviews --status");
    process.exit(1);
  }
  const { table, rows } = await runFulfillPlan(plan, getGithubJson);
  for (const row of rows) {
    const line = [row.number, row.title, row.reviews, row.status, row.files ?? ""].filter((x) => x !== "").join(" | ");
    writePrefetch(`repos/${plan.repo}/pulls/${row.number}`, line);
    writePrefetch(`repos/${plan.repo}/pulls/${row.number}/reviews`, String(row.reviews));
    if (row.files != null) writePrefetch(`repos/${plan.repo}/pulls/${row.number}/files`, String(row.files));
  }
  process.stdout.write(table.endsWith("\n") ? table : `${table}\n`);
}
