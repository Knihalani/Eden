import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Store,
  exportAccessReview,
  exportAudit,
  isAccessReviewExport,
  verifyAccessReview,
  verifyAudit,
} from "@eden/control";
import { readConfig, resolveApiKey, wrapPlaneUrl } from "./home";

export function auditHelp(): string {
  return `eden audit — export and verify the control-plane log

  eden audit export [--format jsonl|csv] [--out file] [--store path] [--url url]
  eden audit review [--format jsonl|csv] [--out file] [--store path] [--url url]
  eden audit verify <file>

JSONL opens in jq. CSV opens in a spreadsheet. export is the full chain
(approvals, versions, executions, refusals). review is who approved what,
when, and which version — tenant-bound, so another org does not see this
workspace's Approves. Each record carries sha256 of the canonical payload
plus prev; splicing a line or flipping a byte fails verify (fail closed).
A broken export never sits on the wrap/agent path.
`;
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function formatOf(args: string[]): "jsonl" | "csv" {
  const raw = (arg(args, "--format") || "jsonl").toLowerCase();
  if (raw === "jsonl" || raw === "csv") return raw;
  throw new Error("format must be jsonl or csv");
}

function defaultStorePath(): string {
  return process.env.EDEN_DB || join(process.env.EDEN_HOME || join(homedir(), ".eden"), "control.sqlite");
}

function orgHeaders(key: string): Record<string, string> {
  const org = (process.env.EDEN_ORG || "").trim();
  return {
    authorization: `Bearer ${key}`,
    ...(org ? { "x-eden-org": org } : {}),
  };
}

async function pullFromApi(
  base: string,
  key: string,
  format: "jsonl" | "csv",
  path: "/v1/audit" | "/v1/audit/review",
): Promise<string> {
  const url = `${base.replace(/\/$/, "")}${path}?format=${format}`;
  const res = await fetch(url, {
    headers: orgHeaders(key),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function exportFromStore(path: string, format: "jsonl" | "csv"): string {
  const store = new Store(path);
  return exportAudit(store, format);
}

function reviewFromStore(path: string, format: "jsonl" | "csv"): string {
  const store = new Store(path);
  return exportAccessReview(store, format);
}

async function dump(args: string[], kind: "export" | "review"): Promise<string> {
  const format = formatOf(args);
  const storePath = arg(args, "--store");
  const urlFlag = arg(args, "--url");
  const fromStore = kind === "review" ? reviewFromStore : exportFromStore;
  const apiPath = kind === "review" ? "/v1/audit/review" : "/v1/audit";
  if (storePath) {
    if (!existsSync(storePath) && storePath !== ":memory:") throw new Error(`no store at ${storePath}`);
    return fromStore(storePath, format);
  }
  const cfg = readConfig();
  const base = wrapPlaneUrl(urlFlag || cfg?.base_url);
  const key = (() => {
    try {
      return resolveApiKey(args);
    } catch {
      return cfg?.api_key;
    }
  })();
  if (key) {
    try {
      return await pullFromApi(base, key, format, apiPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (kind === "review" && /^HTTP 40[13]$/.test(msg)) throw err;
      const fallback = defaultStorePath();
      if (existsSync(fallback)) return fromStore(fallback, format);
      throw err instanceof Error ? err : new Error("export failed");
    }
  }
  const fallback = defaultStorePath();
  if (existsSync(fallback)) return fromStore(fallback, format);
  throw new Error("point --store at control.sqlite, or run eden login / pass --url");
}

export async function runExport(args: string[]): Promise<string> {
  return dump(args, "export");
}

export async function runReview(args: string[]): Promise<string> {
  return dump(args, "review");
}

export function runVerify(text: string): { ok: true; n: number } | { ok: false; reason: string } {
  if (isAccessReviewExport(text)) return verifyAccessReview(text);
  return verifyAudit(text);
}

export async function auditCli(args: string[]): Promise<number> {
  try {
    const sub = args[0];
    if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
      console.log(auditHelp());
      return 0;
    }
    if (sub === "export" || sub === "review") {
      const rest = args.slice(1);
      if (rest.includes("--help") || rest.includes("-h") || rest.includes("help")) {
        console.log(auditHelp());
        return 0;
      }
      const body = sub === "review" ? await runReview(rest) : await runExport(rest);
      const out = arg(rest, "--out");
      if (out) {
        writeFileSync(out, body);
        console.error(`wrote ${out}`);
      } else {
        process.stdout.write(body);
      }
      return 0;
    }
    if (sub === "verify") {
      const file = args[1];
      if (file === "--help" || file === "-h" || file === "help") {
        console.log(auditHelp());
        return 0;
      }
      if (!file || file.startsWith("-")) {
        console.error("audit verify needs a file");
        return 1;
      }
      const text = readFileSync(file, "utf8");
      const result = runVerify(text);
      if (!result.ok) {
        console.error(`verify · fail · ${result.reason}`);
        return 1;
      }
      console.log(`verify · ok · ${result.n} records`);
      return 0;
    }
    console.error(auditHelp());
    return 1;
  } catch (err) {
    console.error(`audit · ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
