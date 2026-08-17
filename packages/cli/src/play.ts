import { readConfig, ensureHome, resolveApiKey, sitePlaneUrl } from "./home";
import {
  bundleJson,
  compactReceipt,
  compactRowFromFacts,
  parseIssueList,
  prRowsFromFacts,
  receiptJson,
  writePrefetch,
  extractGhRepo,
  runFulfillPlan,
  planFromBash,
  type TypedPrRow,
} from "@eden/core";

export async function playCli(args: string[]): Promise<void> {
  ensureHome();
  const name = args[0];
  if (!name) {
    console.error("eden play <tool> --ids 11,12");
    process.exit(1);
  }
  const issuesIdx = args.indexOf("--issues");
  const idsIdx = args.indexOf("--ids");
  const issueIdx = args.indexOf("--issue");
  const issues =
    idsIdx >= 0 ? args[idsIdx + 1] : issuesIdx >= 0 ? args[issuesIdx + 1] : issueIdx >= 0 ? args[issueIdx + 1] : args[1];
  const cfg = readConfig();
  const base = sitePlaneUrl(cfg?.base_url || process.env.EDEN_BASE_URL);
  const key = resolveApiKey(args.slice(1));
  const res = await fetch(`${base}/v1/play`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ name, issues, ids: issues, issue: String(issues || "").split(/[,\s]+/)[0] }),
  });
  const json = (await res.json()) as {
    table?: string;
    facts?: unknown;
    ok?: boolean;
    rows?: TypedPrRow[];
  };
  const issueIds = parseIssueList(issues);
  const rows = json.rows?.length ? json.rows : prRowsFromFacts(json.facts, issueIds);
  const generic = issueIds
    .map((n, i) => {
      const facts =
        json.facts && typeof json.facts === "object" && Array.isArray((json.facts as { rows?: unknown }).rows)
          ? (json.facts as { rows: unknown[] }).rows[i]
          : json.facts;
      return compactRowFromFacts(facts, n);
    })
    .filter((r): r is Record<string, unknown> => r !== null);
  const text = rows.length
    ? bundleJson(rows)
    : generic.length
      ? receiptJson(generic)
      : json.table || compactReceipt(json.facts) || JSON.stringify(json.facts ?? json);
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
