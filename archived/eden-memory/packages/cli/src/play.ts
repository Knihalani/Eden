import { existsSync, readFileSync } from "node:fs";
import { readConfig, ensureHome, resolveApiKey, sitePlaneUrl, wrapBase } from "./home";
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

export const PLAY_USAGE = `eden play <tool> --input '{...}'`;

export function playHelp(): string {
  return `eden play — run a compiled tool

  eden play <tool> --input '{...}'     POST wrap /v1/wrap-run (generic JSON)
  eden play <tool> --input ./in.json    Same, from a file
  eden play <tool> --ids 11,12         GitHub-shaped POST /v1/play (legacy)

Missing name: one sentence on stderr. Wrap down: one sentence, exit 1.
Play does not Approve. Human Approve is the only On switch.
Default wrap is config / 127.0.0.1:8788. A demo sitting on another PORT:
EDEN_WRAP_URL=http://127.0.0.1:8799 eden play <name> --input '{"id":"T-100"}'
`;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

const VALUE_FLAGS = new Set(["--input", "--ids", "--issues", "--issue", "--key"]);

function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") continue;
    if (a.startsWith("--")) {
      if (a.includes("=")) continue;
      if (VALUE_FLAGS.has(a)) i += 1;
      continue;
    }
    return a;
  }
  return undefined;
}

export function parsePlayInput(raw: string | undefined): Record<string, unknown> {
  if (raw == null || raw === "") return {};
  const text = raw !== "-" && existsSync(raw) && !raw.trimStart().startsWith("{") ? readFileSync(raw, "utf8") : raw;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`eden play: --input is not valid JSON (${(e as Error).message})`);
  }
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("eden play: --input must be a JSON object");
  }
  return json as Record<string, unknown>;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const r = await fetchFn(url, { ...init, signal: init.signal ?? AbortSignal.timeout(8_000) });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: "wrap is down" } };
  }
}

function wrapDownSentence(): string {
  return "play: wrap is down · start eden wrap";
}

function asRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function wrapRunErrorSentence(body: unknown): string {
  const rec = asRecord(body);
  const err = typeof rec?.error === "string" ? rec.error : "";
  if (err === "not live") return "play: not live · Approve is the On switch";
  if (err === "paused") return "play: paused · the tool is off";
  if (err === "no registry") return "play: no registry · start eden wrap";
  if (err === "wrap is down") return wrapDownSentence();
  if (err === "deopt") {
    const reason =
      typeof rec?.reason === "string" && rec.reason.trim() ? rec.reason.trim() : "the run left the compiled path";
    return `play: deopt · ${reason}`;
  }
  if (err) return `play: ${err}`;
  return "play: wrap-run failed";
}

function wrapRunSuccessText(body: unknown): string {
  const rec = asRecord(body);
  if (rec && rec.ok === true && "value" in rec) {
    const value = rec.value;
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }
  if (typeof body === "string") return body;
  return JSON.stringify(body ?? {}, null, 2);
}

export async function playCli(args: string[], opts?: { fetch?: typeof fetch }): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(playHelp());
    return 0;
  }
  const name = firstPositional(args);
  if (!name) {
    console.error(PLAY_USAGE);
    return 1;
  }
  const idsRaw = flag(args, "--ids") ?? flag(args, "--issues") ?? flag(args, "--issue");
  const githubShaped = has(args, "--ids") || has(args, "--issues") || has(args, "--issue");
  const fetchFn = opts?.fetch ?? fetch;

  if (githubShaped) {
    return playGithub(name, args, idsRaw, fetchFn);
  }

  let input: Record<string, unknown>;
  try {
    input = parsePlayInput(flag(args, "--input"));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  ensureHome();
  let base: string;
  let key: string;
  try {
    const cfg = readConfig();
    base = wrapBase(cfg);
    key = resolveApiKey(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  const { ok, status, body } = await fetchJson(
    `${base}/v1/wrap-run`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ toolId: name, input, program: { name } }),
    },
    fetchFn,
  );
  if (status === 0) {
    console.error(wrapDownSentence());
    return 1;
  }
  if (!ok) {
    console.error(wrapRunErrorSentence(body));
    return 1;
  }
  const text = wrapRunSuccessText(body);
  if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}

async function playGithub(
  name: string,
  args: string[],
  issues: string | undefined,
  fetchFn: typeof fetch,
): Promise<number> {
  ensureHome();
  const dryRun = has(args, "--dry-run");
  let base: string;
  let key: string;
  try {
    const cfg = readConfig();
    base = sitePlaneUrl(cfg?.base_url || process.env.EDEN_BASE_URL);
    key = resolveApiKey(args.slice(1));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const { ok, status, body } = await fetchJson(
    `${base}/v1/play`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ name, issues, ids: issues, issue: String(issues || "").split(/[,\s]+/)[0], dryRun }),
    },
    fetchFn,
  );
  if (status === 0) {
    console.error(wrapDownSentence());
    return 1;
  }
  const json = (body ?? {}) as {
    table?: string;
    facts?: unknown;
    ok?: boolean;
    rows?: TypedPrRow[];
    error?: string;
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
  if (!ok || json.ok === false) return 1;
  return 0;
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
