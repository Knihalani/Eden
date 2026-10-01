/**
 * M32 Terminal-Bench 2.1 Δ runner (RESULTS / renderResults).
 * Harbor launch / findJobDir / startWrap: M32.1. Remain-silent counts: M32.3.
 *
 * Same NVIDIA NIM agent through Eden wrap:
 *   WITH inject  (EDEN_MEMORY unset / on)  vs
 *   WITHOUT      (EDEN_MEMORY=0 identity)
 *
 * Product path: wrap `injectBodyThenObserveTools(processMemory(), body)`
 * on POST /v1/chat/completions. Not BrainMemory. Not a public-board claim.
 * Absolute % is the agent (terminus-2), not Eden. Memory = Δ vs locked harness k=5 (Plan §9.2 CLI SOTA).
 *
 *   bun benchmarks/terminal-bench/run.ts
 *
 * Env (from gitignored repo .env; never printed):
 *   NVIDIA_API_KEY, NVIDIA_BASE_URL, NIM_MODEL
 *
 * Optional:
 *   TB_TASKS=terminal-bench/openssl-selfsigned-cert  (override subset)
 *   TB_K=5
 *   TB_CONCURRENCY=1
 *   TB_SKIP_HARBOR=1  (install/probe only)
 *   TB_REPARSE=1 or `--reparse`  (re-render RESULTS from existing jobs; no Harbor)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
// --- M32.3 remain-silent measure (count only; omit gate is M38) ---
import { silenceNotes } from "./silence.ts";

export const ROOT = join(import.meta.dir, "../..");
export const HERE = import.meta.dir;
export const SUBSET_PATH = join(HERE, "subset.json");
export const RESULTS_PATH = join(HERE, "RESULTS.md");
export const LAST_RUN_PATH = join(HERE, ".last-run.json");
export const JOBS_DIR = join(HERE, "jobs");
export const DATA_DIR = join(HERE, ".data");
export const DATASET_DIR = join(HERE, "dataset");
export const TASKS_DIR = join(DATASET_DIR, "tasks");

export const WAVE = "M32" as const;
export const WRAP_INJECT = "packages/wrap handleChatCompletions → injectBodyThenObserveTools(processMemory())";
export const NIM_BASE = "https://integrate.api.nvidia.com/v1";
export const NIM_MODEL = "google/gemma-4-31b-it";
export const DEFAULT_WRAP_PORT = 18788;
/**
 * Live wrap listen port. Prefer 18788; leftover listeners are killed, else a free port is written
 * into Harbor config.
 */
let wrapPort = DEFAULT_WRAP_PORT;
function wrapOrigin(): string {
  return `http://127.0.0.1:${wrapPort}`;
}
// Harbor's OPENAI_API_KEY is this wrap's own key, so wrap pays upstream with the NVIDIA key it holds.
// A stand-in `sk-` key no longer works: wrap forwards a provider key as the caller's own (#84).
const HARBOR_WRAP_KEY = `eden_tb_${randomBytes(16).toString("hex")}`;
const DATASET_GIT = "https://github.com/harbor-framework/terminal-bench-2-1.git";
const DATASET_HUB = "terminal-bench/terminal-bench-2-1";

export type Arm = "off" | "on";

export type Subset = {
  id: string;
  schema: number;
  dataset: string;
  harness: string;
  agent: string;
  k: number;
  public_board: boolean;
  note: string;
  tasks: string[];
};

export type TokenUse = {
  prompt: number;
  completion: number;
  total: number;
  measured: boolean;
};

export type TrialRow = {
  task: string;
  trial: string;
  reward: number | null;
  error?: string;
  error_message?: string;
  tokens: TokenUse;
};

export type ArmResult = {
  arm: Arm;
  eden_memory: string;
  job_dir: string | null;
  n_trials: number;
  n_resolved: number;
  n_errored: number;
  accuracy: number | null;
  harbor_mean: number | null;
  tokens: TokenUse;
  dollars: number;
  trials: TrialRow[];
  harbor_ran: boolean;
  error?: string;
};

export type InjectCheck = {
  off_identity: boolean;
  on_has_mark: boolean;
  on_has_fact: boolean;
};

/** M32.3 fills empty vs junk. This runner does not classify packets. */
export type SilenceMeasure = {
  empty?: number;
  junk?: number;
  [key: string]: unknown;
};

export type RunDelta = {
  accuracy_pp: number | null;
  tokens_total: number | null;
  dollars: number | null;
};

export type RunReport = {
  wave: typeof WAVE;
  date: string;
  harness: string;
  harbor_cli: string | null;
  harbor_ran: boolean;
  harbor_dry_run: boolean;
  dataset: string;
  dataset_source: string;
  public_board: boolean;
  n: number;
  k: number;
  model: string;
  agent: string;
  wrap: string;
  nim_base: string;
  reasoning_effort: string;
  tasks: string[];
  nvidia_trial_usd_per_mtok: { input: number; output: number };
  inject: InjectCheck | null;
  silence?: SilenceMeasure | null;
  off: ArmResult;
  on: ArmResult;
  delta: RunDelta;
  blockers: string[];
  notes: string[];
};

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null) process.env[k] = v;
  }
}

function nvidiaKey(): string {
  const k = (process.env.NVIDIA_API_KEY || "").trim();
  if (!k) throw new Error("NVIDIA_API_KEY missing from env / .env");
  return k;
}

function modelId(): string {
  process.env.NIM_MODEL = NIM_MODEL;
  return NIM_MODEL;
}

export function sanitizeModelId(id: string): string {
  return id.replaceAll("/", "-");
}

/** M15 dirs stay `eden-m153-…` historical. New Harbor jobs are wave-tagged + model-tagged. */
export function jobName(arm: Arm): string {
  return `eden-m32-${arm}-${sanitizeModelId(modelId())}`;
}

export function injectLogPath(arm: Arm): string {
  return join(DATA_DIR, `inject-${arm}.jsonl`);
}

/** HTTP 504 / 502 / BadGateway must never become TB_SKIP_HARBOR. */
export function shouldSkipHarborForHttp(status: number | null): boolean {
  if (status === 504 || status === 502) return false;
  return false;
}

function nimBase(): string {
  return ((process.env.NVIDIA_BASE_URL || NIM_BASE).trim() || NIM_BASE).replace(/\/$/, "");
}

function loadSubset(): Subset {
  const raw = JSON.parse(readFileSync(SUBSET_PATH, "utf8")) as Subset;
  const override = (process.env.TB_TASKS || "").trim();
  if (override) raw.tasks = override.split(/[,\s]+/).filter(Boolean);
  const k = Number(process.env.TB_K);
  if (Number.isInteger(k) && k > 0) raw.k = k;
  return raw;
}

function sh(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { timeoutMs, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...spawnOpts,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b) => {
      stdout += String(b);
    });
    child.stderr?.on("data", (b) => {
      stderr += String(b);
    });
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
          }, timeoutMs)
        : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function which(bin: string): Promise<string | null> {
  const r = await sh("which", [bin]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const p = r.stdout.trim();
  if (r.code === 0 && p) return p;
  const homeBin = join(process.env.HOME || "", ".local/bin", bin);
  if (existsSync(homeBin)) return homeBin;
  return null;
}

async function ensureHarbor(): Promise<{ bin: string | null; error?: string }> {
  const existing = (await which("harbor")) || (await which("uvx"));
  if (await which("harbor")) return { bin: (await which("harbor"))! };
  const uv = await which("uv");
  if (uv) {
    const inst = await sh(uv, ["tool", "install", "harbor"], { timeoutMs: 180_000 });
    if (inst.code === 0 && (await which("harbor"))) return { bin: (await which("harbor"))! };
    const uvx = await which("uvx");
    if (uvx) return { bin: uvx, error: inst.stderr.slice(-400) };
    return { bin: null, error: `uv tool install harbor failed: ${(inst.stderr || inst.stdout).slice(-800)}` };
  }
  const pip = (await which("pip3")) || (await which("pip")) || (await which("python3"));
  if (pip && (pip.endsWith("pip") || pip.endsWith("pip3"))) {
    const inst = await sh(pip, ["install", "--user", "harbor"], { timeoutMs: 180_000 });
    if (inst.code === 0 && (await which("harbor"))) return { bin: (await which("harbor"))! };
    return { bin: null, error: `pip install harbor failed: ${(inst.stderr || inst.stdout).slice(-800)}` };
  }
  if (pip && pip.endsWith("python3")) {
    const inst = await sh(pip, ["-m", "pip", "install", "--user", "harbor"], { timeoutMs: 180_000 });
    if (inst.code === 0 && (await which("harbor"))) return { bin: (await which("harbor"))! };
    return { bin: null, error: `python3 -m pip install harbor failed: ${(inst.stderr || inst.stdout).slice(-800)}` };
  }
  return { bin: null, error: "Harbor CLI missing and neither uv nor pip is available to install it" };
}

async function dockerOk(): Promise<string | null> {
  const r = await sh("docker", ["info"], { timeoutMs: 20_000 }).catch((e) => ({
    code: 1,
    stdout: "",
    stderr: String(e),
  }));
  if (r.code === 0) return null;
  return `Docker daemon not usable: ${(r.stderr || r.stdout).slice(-400)}`;
}

async function ensureDataset(): Promise<{ source: string; error?: string }> {
  if (existsSync(join(TASKS_DIR, "regex-log")) && existsSync(join(TASKS_DIR, "openssl-selfsigned-cert"))) {
    return { source: `git-clone:${DATASET_GIT} (cached)` };
  }
  mkdirSync(HERE, { recursive: true });
  if (existsSync(DATASET_DIR)) rmSync(DATASET_DIR, { recursive: true, force: true });
  const git = await sh("git", ["clone", "--depth", "1", DATASET_GIT, DATASET_DIR], { timeoutMs: 180_000 });
  if (git.code !== 0) {
    return {
      source: "missing",
      error: `git clone ${DATASET_GIT} failed: ${(git.stderr || git.stdout).slice(-800)}`,
    };
  }
  if (!existsSync(TASKS_DIR)) {
    return { source: "missing", error: `clone succeeded but ${TASKS_DIR} is missing` };
  }
  return { source: `git-clone:${DATASET_GIT}` };
}

function harborBin(info: { bin: string | null }): { cmd: string; prefix: string[] } {
  if (!info.bin) return { cmd: "harbor", prefix: [] };
  if (info.bin.endsWith("uvx") || info.bin.includes("/uvx")) return { cmd: info.bin, prefix: ["harbor"] };
  return { cmd: info.bin, prefix: [] };
}

function curlNimChatSync(
  model: string,
  timeoutSec: number,
): { http: number | null; ms: number; snippet: string; empty: boolean } {
  const key = nvidiaKey();
  const payload = JSON.stringify({
    model,
    messages: [{ role: "user", content: "Say hi in one word." }],
    max_tokens: 16,
    stream: false,
    temperature: 0,
  });
  const script = `curl -sS --http1.1 -D - --max-time ${timeoutSec} \
    -H "Authorization: Bearer $NVIDIA_API_KEY" \
    -H "Content-Type: application/json" \
    -H "NVCF-POLL-SECONDS: 30" \
    ${nimBase()}/chat/completions -d @-`;
  const t0 = Date.now();
  const r = spawnSync("bash", ["-lc", script], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, NVIDIA_API_KEY: key },
    timeout: (timeoutSec + 5) * 1000,
  });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`.replaceAll(key, "[redacted]");
  const m = out.match(/HTTP\/[\d.]+ (\d+)/);
  return {
    http: m ? Number(m[1]) : null,
    ms: Date.now() - t0,
    snippet: out.slice(0, 280),
    empty:
      /Empty reply|timed out after|0 bytes received|ECONNRESET|RemoteProtocolError/i.test(out) &&
      !/"content":"[^"]+"/.test(out),
  };
}

async function probeNim(): Promise<{ error: string | null; sibling?: string }> {
  for (let i = 0; i < 4; i++) {
    try {
      const key = nvidiaKey();
      const models = await fetch(`${nimBase()}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
      const mt = await models.text();
      if (models.ok && mt.includes(modelId())) break;
    } catch {
      /* POST chat is the real probe; catalog can flake */
    }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  let last = "";
  for (let i = 0; i < 3; i++) {
    const hit = curlNimChatSync(modelId(), 45);
    const body = hit.snippet.replace(/\s+/g, " ");
    if (hit.http === 200 && !hit.empty && /"content":/i.test(body + hit.snippet)) return { error: null };
    if (hit.http === 200 && !hit.empty) return { error: null };
    last = `http=${hit.http ?? "none"} ${hit.ms}ms empty=${hit.empty} ${body.slice(0, 160)}`;
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return {
    error: `NIM POST /v1/chat/completions model ${modelId()} did not return a completion after retries. ${last}`,
  };
}

async function injectSelfCheck(): Promise<InjectCheck> {
  const { MEMORY_MARK, openMemory } = await import("../../src/index.ts");
  const { injectBodyThenObserveTools } = await import("../../packages/wrap/src/tool-observe.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "eden-m153-inject-"));
  const body = { model: modelId(), messages: [{ role: "user", content: "What store is sqlite?" }] };
  const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) prev[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      return fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  try {
    const off = withEnv({ EDEN_MEMORY: "0", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
      const mem = openMemory({ dir: join(dir, "off") });
      mem.observe([{ role: "user", content: "Postgres is the session store." }]);
      return injectBodyThenObserveTools(mem, structuredClone(body));
    });
    const on = withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
      const mem = openMemory({ dir: join(dir, "on") });
      mem.observe([{ role: "user", content: "Postgres is the session store." }]);
      return injectBodyThenObserveTools(mem, structuredClone(body));
    });
    const offS = JSON.stringify(off);
    const onS = JSON.stringify(on);
    return {
      off_identity: !offS.includes(MEMORY_MARK),
      on_has_mark: onS.includes(MEMORY_MARK),
      on_has_fact: /postgres/i.test(onS),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function harborDryRun(h: { cmd: string; prefix: string[] }, subset: Subset): Promise<string | null> {
  const cfg = writeHarborConfig("off", subset);
  const localBin = join(process.env.HOME || "", ".local/bin");
  const r = await sh(
    h.cmd,
    [...h.prefix, "run", "--config", cfg, "-k", String(subset.k), "-n", "1", "-y", "--dry-run"],
    {
      cwd: HERE,
      env: { ...process.env, PATH: `${localBin}:${process.env.PATH || ""}`, OPENAI_API_KEY: HARBOR_WRAP_KEY },
      timeoutMs: 60_000,
    },
  );
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code === 0 && /Dry run OK/i.test(out)) return null;
  return `harbor --dry-run exit ${r.code}: ${out.slice(-600)}`;
}

function listenersOnPort(port: number): number[] {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  const raw = (r.stdout || "").trim();
  if (r.status !== 0 || !raw) return [];
  return [
    ...new Set(
      raw
        .split(/\s+/)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 1 && n !== process.pid),
    ),
  ];
}

async function killPortListeners(port: number): Promise<void> {
  for (const pid of listenersOnPort(port)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await Bun.sleep(250);
  for (const pid of listenersOnPort(port)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await Bun.sleep(100);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => {
      s.close(() => resolve(true));
    });
  });
}

function allocPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => (port > 0 ? resolve(port) : reject(new Error("no ephemeral port"))));
    });
  });
}

/** Free leftover wrap on 18788; if still bound, pick a free port Harbor config will use. */
async function ensureWrapPort(): Promise<number> {
  await killPortListeners(DEFAULT_WRAP_PORT);
  if (wrapPort !== DEFAULT_WRAP_PORT) await killPortListeners(wrapPort);
  if (await portFree(DEFAULT_WRAP_PORT)) {
    wrapPort = DEFAULT_WRAP_PORT;
    return wrapPort;
  }
  wrapPort = await allocPort();
  return wrapPort;
}

function startWrap(arm: Arm): { child: ChildProcess; log: string; port: number } {
  mkdirSync(DATA_DIR, { recursive: true });
  const home = join(DATA_DIR, `home-${arm}`);
  const mem = join(DATA_DIR, `mem-${arm}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(mem, { recursive: true });
  const injectLog = injectLogPath(arm);
  try {
    writeFileSync(injectLog, "");
  } catch {
    /* M32.3 reads this path; fail-open if truncate throws */
  }
  const log = join(HERE, `wrap-${arm}.log`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENAI_API_KEY: nvidiaKey(),
    OPENAI_API_BASE: nimBase(),
    EDEN_API_KEY: HARBOR_WRAP_KEY,
    EDEN_DEV: "1",
    EDEN_HOME: home,
    EDEN_MEMORY_DIR: mem,
    EDEN_MEMORY: arm === "off" ? "0" : "on",
    EDEN_WRAP_HOST: "127.0.0.1",
    PORT: String(wrapPort),
    EDEN_UPSTREAM_TIMEOUT_MS: "180000",
    NIM_MODEL: modelId(),
    EDEN_MEMORY_INJECT_LOG: injectLog,
  };
  const child = spawn(
    "bun",
    [join(ROOT, "packages/cli/src/cli.ts"), "wrap", "--no-coding", "--port", String(wrapPort), "--host", "127.0.0.1"],
    {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stream = { n: 0 };
  const onChunk = (b: Buffer) => {
    stream.n += b.length;
    try {
      writeFileSync(log, b, { flag: "a" });
    } catch {}
  };
  try {
    writeFileSync(log, "");
  } catch {}
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  void stream;
  return { child, log, port: wrapPort };
}

async function waitWrap(timeoutMs = 20_000): Promise<string | null> {
  const t0 = Date.now();
  const origin = wrapOrigin();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return null;
    } catch {}
    await Bun.sleep(250);
  }
  return `wrap did not become healthy at ${origin}/health`;
}

async function probeWrap(): Promise<string | null> {
  let last = "wrap chat: no attempts";
  const origin = wrapOrigin();
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${HARBOR_WRAP_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: modelId(),
          messages: [{ role: "user", content: "Reply with the single word pong." }],
          max_tokens: 32,
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await r.text();
      if (r.ok) return null;
      last = `wrap chat HTTP ${r.status}: ${text.slice(0, 240)}`;
      void shouldSkipHarborForHttp(r.status);
    } catch (e) {
      last = `wrap chat: ${String(e).slice(0, 200)}`;
    }
    await Bun.sleep(2000 * (i + 1));
  }
  return last;
}

function stopChild(child: ChildProcess | undefined): void {
  if (!child || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {}
}

function taskDirName(task: string): string {
  return task.includes("/") ? task.split("/").pop()! : task;
}

function writeHarborConfig(arm: Arm, subset: Subset): string {
  mkdirSync(JOBS_DIR, { recursive: true });
  mkdirSync(join(JOBS_DIR, jobName(arm)), { recursive: true });
  const include = subset.tasks.map((t) => taskDirName(t));
  const cfg = {
    job_name: jobName(arm),
    jobs_dir: JOBS_DIR,
    n_attempts: subset.k,
    n_concurrent_trials: Math.max(1, Number(process.env.TB_CONCURRENCY) || 1),
    timeout_multiplier: 3.0,
    agents: [
      {
        name: "terminus-2",
        model_name: `openai/${modelId()}`,
        kwargs: {
          api_base: `${wrapOrigin()}/v1`,
          temperature: 0.7,
          model_info: {
            max_input_tokens: 128000,
            max_output_tokens: 16384,
            input_cost_per_token: 0,
            output_cost_per_token: 0,
          },
        },
      },
    ],
    datasets: [
      {
        path: TASKS_DIR,
        task_names: include,
      },
    ],
    // Keep trial dirs until result.json is written. Harbor 0.23 `_finalize`
    // writes result.json after `_stop_agent_environment`; deleting the env
    // races FileNotFoundError and kills the job at 0/10 (M32 off-arm 2026-09-21).
    environment: {
      type: "docker",
      delete: false,
    },
  };
  const path = join(HERE, `harbor-${arm}.json`);
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return path;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function addTokens(a: TokenUse, b: TokenUse): TokenUse {
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    total: a.total + b.total,
    measured: a.measured || b.measured,
  };
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

/** Harbor trial tokens live on `agent_result`; job totals live on `stats`. */
export function tokensFrom(obj: unknown): TokenUse {
  const z: TokenUse = { prompt: 0, completion: 0, total: 0, measured: false };
  if (!obj || typeof obj !== "object") return z;
  const o = obj as Rec;
  const agent = rec(o.agent_result);
  const stats = rec(o.stats);
  const usage = rec(o.usage) ?? o;
  const p =
    num(agent?.n_input_tokens) ??
    num(stats?.n_input_tokens) ??
    num(usage.prompt_tokens) ??
    num(usage.input_tokens) ??
    num(o.n_input_tokens) ??
    num(o.prompt_tokens) ??
    0;
  const c =
    num(agent?.n_output_tokens) ??
    num(stats?.n_output_tokens) ??
    num(usage.completion_tokens) ??
    num(usage.output_tokens) ??
    num(o.n_output_tokens) ??
    num(o.completion_tokens) ??
    0;
  const t = num(usage.total_tokens) ?? num(stats?.n_tokens) ?? num(o.n_tokens) ?? p + c;
  if (p || c || t) return { prompt: p, completion: c, total: t || p + c, measured: true };
  return z;
}

/** Harbor stores the score at `verifier_result.rewards.reward`, not `verifier_result.reward`. */
export function rewardOf(obj: unknown): number | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Rec;
  const vr = rec(o.verifier_result);
  if (vr) {
    const nested = num(rec(vr.rewards)?.reward);
    if (nested != null) return nested;
    const flat = num(vr.reward);
    if (flat != null) return flat;
  }
  return num(o.reward) ?? num(o.mean_reward);
}

export function harborMeanFromJob(obj: unknown): number | null {
  const stats = rec(rec(obj)?.stats);
  const evals = rec(stats?.evals);
  if (!evals) return null;
  for (const v of Object.values(evals)) {
    const ev = rec(v);
    const metrics = ev?.metrics;
    if (!Array.isArray(metrics) || !metrics[0]) continue;
    const m = num(rec(metrics[0])?.mean);
    if (m != null) return m;
  }
  return num(stats?.mean_reward) ?? num(rec(obj)?.mean_reward);
}

function exceptionOf(obj: Rec): { type?: string; message?: string } {
  const info = rec(obj.exception_info);
  if (!info) return {};
  return {
    type: typeof info.exception_type === "string" ? info.exception_type : undefined,
    message: typeof info.exception_message === "string" ? info.exception_message : undefined,
  };
}

function emptyArm(arm: Arm, jobDir: string | null, harborRan: boolean, error?: string): ArmResult {
  return {
    arm,
    eden_memory: arm === "off" ? "0" : "on",
    job_dir: jobDir,
    n_trials: 0,
    n_resolved: 0,
    n_errored: 0,
    accuracy: null,
    harbor_mean: null,
    tokens: { prompt: 0, completion: 0, total: 0, measured: false },
    dollars: 0,
    trials: [],
    harbor_ran: harborRan,
    error,
  };
}

function readJobConfig(dir: string): Rec | null {
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Rec;
  } catch {
    return null;
  }
}

function dirBase(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Accept only configs whose agent model is the current NIM id.
 * GLM / z-ai / missing model never match — stale `eden-m153-off` cannot block Gemma.
 */
export function jobDirModelOk(cfg: unknown, want = modelId()): boolean {
  const o = rec(cfg);
  if (!o) return false;
  const names: string[] = [];
  if (Array.isArray(o.agents)) {
    for (const a of o.agents) {
      const n = rec(a)?.model_name;
      if (typeof n === "string" && n.trim()) names.push(n);
    }
  }
  if (typeof o.model === "string" && o.model.trim()) names.push(o.model);
  if (typeof o.model_name === "string" && o.model_name.trim()) names.push(o.model_name);
  if (!names.length) return false;
  const blob = names.join(" ").toLowerCase();
  if (blob.includes("z-ai") || /\bglm(?:-|\d|\b)/i.test(blob)) return false;
  const id = want.toLowerCase();
  const slug = sanitizeModelId(id);
  return names.some((n) => {
    const x = n.toLowerCase();
    return x.includes(id) || x.includes(slug);
  });
}

function jobDirUsable(dir: string): boolean {
  const cfg = readJobConfig(dir);
  if (!cfg) return false;
  return jobDirModelOk(cfg);
}

/** Prefer exact `eden-m32-${arm}-${model}` dir. Never return GLM / z-ai / wrong-model jobs. */
export function findJobDir(arm: Arm): string | null {
  if (!existsSync(JOBS_DIR)) return null;
  const want = jobName(arm);
  const named = join(JOBS_DIR, want);
  if (existsSync(named) && jobDirUsable(named)) return named;

  let kids: string[] = [];
  try {
    kids = readdirSync(JOBS_DIR)
      .map((n) => join(JOBS_DIR, n))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return null;
  }
  kids.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });

  const exact = kids.find((p) => dirBase(p) === want && jobDirUsable(p));
  if (exact) return exact;
  const prefixed = kids.find((p) => dirBase(p).startsWith(`${want}`) && jobDirUsable(p));
  if (prefixed) return prefixed;
  const byName = kids.find((p) => {
    if (!jobDirUsable(p)) return false;
    const cfg = readJobConfig(p);
    return cfg?.job_name === want;
  });
  return byName ?? null;
}

export function harborRanFrom(jobDir: string | null, launched: boolean): boolean {
  if (!launched || !jobDir || !existsSync(jobDir)) return false;
  if (existsSync(join(jobDir, "result.json"))) return true;
  try {
    for (const n of readdirSync(jobDir)) {
      if (existsSync(join(jobDir, n, "result.json"))) return true;
    }
  } catch {}
  return false;
}

export function parseArm(arm: Arm, jobDir: string | null, harborRan: boolean, error?: string): ArmResult {
  const empty = emptyArm(arm, jobDir, harborRan, error);
  if (!jobDir || !existsSync(jobDir)) return empty;

  const jobFile = join(jobDir, "result.json");
  let jobJson: Rec | null = null;
  if (existsSync(jobFile)) {
    try {
      jobJson = JSON.parse(readFileSync(jobFile, "utf8")) as Rec;
    } catch {
      jobJson = null;
    }
  }

  const trials: TrialRow[] = [];
  const kids = existsSync(jobDir)
    ? readdirSync(jobDir)
        .map((n) => join(jobDir, n))
        .filter((p) => {
          try {
            return statSync(p).isDirectory();
          } catch {
            return false;
          }
        })
    : [];
  for (const dir of kids) {
    const f = join(dir, "result.json");
    if (!existsSync(f)) continue;
    let j: Rec;
    try {
      j = JSON.parse(readFileSync(f, "utf8")) as Rec;
    } catch {
      continue;
    }
    const exc = exceptionOf(j);
    const tok = tokensFrom(j);
    trials.push({
      task: String(j.task_name ?? j.task ?? dir.split("/").pop() ?? "?"),
      trial: String(j.trial_name ?? j.trial_id ?? dir.split("/").pop() ?? "?"),
      reward: rewardOf(j),
      error: exc.type,
      error_message: exc.message,
      tokens: tok,
    });
  }
  trials.sort((a, b) => a.trial.localeCompare(b.trial));

  const jobTokens = jobJson ? tokensFrom(jobJson) : empty.tokens;
  const trialTokens = trials.reduce((acc, t) => addTokens(acc, t.tokens), empty.tokens);
  const tokens = jobTokens.measured ? jobTokens : trialTokens;

  const n = trials.length || num(jobJson?.n_total_trials) || 0;
  const resolved = trials.filter((t) => t.reward != null && t.reward >= 1).length;
  const nErroredStats = num(rec(jobJson?.stats)?.n_errored_trials);
  const n_errored = nErroredStats != null ? nErroredStats : trials.filter((t) => t.error).length;
  const harbor_mean = harborMeanFromJob(jobJson);
  // Prefer Harbor's mean (errors counted as 0 over n_total_trials). Fallback: n_resolved/n_trials.
  const accuracy = harbor_mean != null ? harbor_mean : n ? resolved / n : null;

  return {
    arm,
    eden_memory: arm === "off" ? "0" : "on",
    job_dir: jobDir,
    n_trials: n,
    n_resolved: resolved,
    n_errored,
    accuracy,
    harbor_mean,
    tokens,
    dollars: 0,
    trials,
    harbor_ran: harborRan,
    error,
  };
}

function namedErrors(arm: ArmResult, pred: (t: TrialRow) => boolean): string {
  return arm.trials
    .filter(pred)
    .map((t) => t.trial)
    .join(", ");
}

export function memoryDeltaNotes(off: ArmResult, on: ArmResult): string[] {
  const notes: string[] = [];
  notes.push(
    "Accuracy is Harbor's own mean over n_total_trials (errored trials counted as 0 in that mean). n_resolved/n_trials is also published. Errored trials are named exceptions, not silent reward 0.0.",
  );
  const regexOff = namedErrors(off, (t) => t.trial.startsWith("regex-log") && Boolean(t.error));
  const regexOn = namedErrors(on, (t) => t.trial.startsWith("regex-log") && Boolean(t.error));
  if (regexOff) {
    const sample = off.trials.find((t) => t.trial.startsWith("regex-log") && t.error_message)?.error_message;
    notes.push(`regex-log tmux failures (off, all 5): ${regexOff}${sample ? ` — ${sample}` : ""}.`);
  }
  if (regexOn) {
    const sample = on.trials.find((t) => t.trial.startsWith("regex-log") && t.error_message)?.error_message;
    notes.push(`regex-log tmux failures (on): ${regexOn}${sample ? ` — ${sample}` : ""}.`);
  }
  const onBg = namedErrors(on, (t) => t.error === "BadGatewayError");
  const onRt = namedErrors(on, (t) => t.error === "RuntimeError" && !t.trial.startsWith("regex-log"));
  if (on.n_errored > off.n_errored) {
    notes.push(
      `On-arm had more errors (${on.n_errored} vs off ${off.n_errored}): RuntimeError tmux also hit openssl (${onRt || "none"})${onBg ? `; BadGatewayError on ${onBg}` : ""}. Δ is not a clean memory effect.`,
    );
  }
  notes.push("NVIDIA hosted trial list price is $0/MTok; token counts are reported, $ Δ is $0.0000.");
  return notes;
}

function fmtPct(x: number | null): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${(x * 100).toFixed(1)}%`;
}

function fmtPp(x: number | null): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  const s = (x * 100).toFixed(1);
  return `${x >= 0 ? "+" : ""}${s} pp`;
}

function fmtN(x: number | null): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return String(Math.round(x));
}

/** LOSS if Δ accuracy < 0. Honest zero is not a win. Positive Δ is a number, not SOTA. */
export function accuracyVerdict(pp: number | null): string | null {
  if (pp == null || !Number.isFinite(pp)) return null;
  if (pp < 0) return "**Δ accuracy is a LOSS.** On-arm is worse; do not read this as a memory win.";
  if (pp === 0) return "**Δ accuracy is 0.0 pp.** Honest zero — not a memory win.";
  return null;
}

const LOCKED_NOTES = [
  "Locked subset, k=5, both arms through wrap. Full 89×5×2 was not run.",
  "Wrap `--no-coding` so the Δ is memory inject, not stretch compile.",
  "Harbor OPENAI_API_KEY is the local wrap's own key (`eden_tb_…`); upstream NVIDIA key stays in the wrap process.",
] as const;

/** Dated M32 schema with no Harbor numbers. Orchestrator re-run fills Δ. Does not invent remain-silent counts. */
export function pendingResultsReport(date = new Date().toISOString().slice(0, 10)): RunReport {
  const subset = loadSubset();
  return {
    wave: WAVE,
    date,
    harness: "Harbor CLI + terminus-2 + Docker (timeout_multiplier=3.0)",
    harbor_cli: null,
    harbor_ran: false,
    harbor_dry_run: false,
    dataset: DATASET_HUB,
    dataset_source: "pending",
    public_board: false,
    n: subset.tasks.length,
    k: subset.k,
    model: NIM_MODEL,
    agent: "terminus-2",
    wrap: WRAP_INJECT,
    nim_base: NIM_BASE,
    reasoning_effort: "n/a",
    tasks: subset.tasks,
    nvidia_trial_usd_per_mtok: { input: 0, output: 0 },
    inject: null,
    off: parseArm("off", null, false),
    on: parseArm("on", null, false),
    delta: { accuracy_pp: null, tokens_total: null, dollars: 0 },
    blockers: [],
    notes: [
      ...LOCKED_NOTES,
      "M32 Harbor fill pending — orchestrator will re-run. Frozen M15 Δ is in benchmarks/memoryagentbench/M15-EVIDENCE.md.",
    ],
  };
}

export function renderResults(r: RunReport): string {
  const lines: string[] = [];
  lines.push("# M32 Terminal-Bench 2.1 Δ RESULTS");
  lines.push("");
  lines.push(`**M37.3 recert:** ${r.date} — after M16–M36; locked subset k=5; not 89-task; backbone \`${NIM_MODEL}\`.`);
  lines.push("");
  if (!r.harbor_ran) {
    lines.push("**Harbor ran: no.** Jobs were not launched in this file. No public-board % is claimed.");
    lines.push("");
  }
  lines.push(
    "Own schema (not MAB Table 3 / not LME-V2). Absolute % is the **agent** (**terminus-2**), not Eden. Memory claim is **Δ** vs the same locked harness (Plan §9.2 CLI SOTA: k=5, wrap ± inject).",
  );
  lines.push("");
  lines.push("| field | value |");
  lines.push("|---|---|");
  lines.push(`| wave | ${r.wave} |`);
  lines.push(`| date | ${r.date} |`);
  lines.push(`| harness | ${r.harness} |`);
  lines.push(`| Harbor CLI | ${r.harbor_cli ?? "not found"} |`);
  lines.push(`| Harbor ran | ${r.harbor_ran ? "yes" : "no"} |`);
  lines.push(`| Harbor dry-run | ${r.harbor_dry_run ? "OK" : "not run / fail"} |`);
  lines.push(`| dataset | ${r.dataset} |`);
  lines.push(`| dataset source | ${r.dataset_source} |`);
  lines.push(`| public board (89 tasks) | ${r.public_board ? "yes" : "**no — locked subset**"} |`);
  lines.push(`| n (tasks) | ${r.n} |`);
  lines.push(`| k (trials / task) | ${r.k} |`);
  lines.push(`| model | \`${r.model}\` |`);
  lines.push(`| agent | ${r.agent} |`);
  lines.push(`| wrap | ${r.wrap} |`);
  if (r.inject) {
    lines.push(
      `| inject check | off identity=${r.inject.off_identity}; on mark=${r.inject.on_has_mark}; on fact=${r.inject.on_has_fact} |`,
    );
  }
  lines.push(`| NIM base | ${r.nim_base} |`);
  lines.push(`| reasoning_effort | ${r.reasoning_effort} (both arms) |`);
  lines.push(
    `| NVIDIA trial $/MTok | input ${r.nvidia_trial_usd_per_mtok.input} / output ${r.nvidia_trial_usd_per_mtok.output} |`,
  );
  lines.push(`| tasks | ${r.tasks.map((t) => "`" + t + "`").join(", ")} |`);
  lines.push("");
  lines.push("## Δ (on − off)");
  lines.push("");
  lines.push("| metric | off (EDEN_MEMORY=0 identity) | on (inject) | Δ |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| accuracy (Harbor mean) | ${fmtPct(r.off.accuracy)} | ${fmtPct(r.on.accuracy)} | ${fmtPp(r.delta.accuracy_pp)} |`,
  );
  const tokOff = r.off.tokens.measured;
  const tokOn = r.on.tokens.measured;
  lines.push(
    `| tokens prompt | ${tokOff ? fmtN(r.off.tokens.prompt) : "n/a"} ` +
      `| ${tokOn ? fmtN(r.on.tokens.prompt) : "n/a"} ` +
      `| ${tokOff && tokOn ? fmtN(r.on.tokens.prompt - r.off.tokens.prompt) : "n/a"} |`,
  );
  lines.push(
    `| tokens completion | ${tokOff ? fmtN(r.off.tokens.completion) : "n/a"} ` +
      `| ${tokOn ? fmtN(r.on.tokens.completion) : "n/a"} ` +
      `| ${tokOff && tokOn ? fmtN(r.on.tokens.completion - r.off.tokens.completion) : "n/a"} |`,
  );
  lines.push(
    `| tokens total | ${tokOff ? fmtN(r.off.tokens.total) : "n/a"} | ${tokOn ? fmtN(r.on.tokens.total) : "n/a"} | ${fmtN(r.delta.tokens_total)} |`,
  );
  const dollarOff = r.harbor_ran ? `$${r.off.dollars.toFixed(4)}` : "n/a";
  const dollarOn = r.harbor_ran ? `$${r.on.dollars.toFixed(4)}` : "n/a";
  const dollarD = r.harbor_ran ? `$${(r.delta.dollars ?? 0).toFixed(4)}` : "n/a";
  lines.push(`| $ (NVIDIA trial $0/MTok) | ${dollarOff} | ${dollarOn} | ${dollarD} |`);
  lines.push(`| n_trials | ${r.off.n_trials} | ${r.on.n_trials} | |`);
  lines.push(`| n_resolved (reward=1.0) | ${r.off.n_resolved} | ${r.on.n_resolved} | |`);
  lines.push(
    `| n_resolved / n_trials | ${r.off.n_trials ? `${r.off.n_resolved}/${r.off.n_trials}` : "n/a"} | ${r.on.n_trials ? `${r.on.n_resolved}/${r.on.n_trials}` : "n/a"} | |`,
  );
  lines.push(`| n_errored | ${r.off.n_errored} | ${r.on.n_errored} | |`);
  lines.push("");
  lines.push(
    "**Accuracy definition:** Harbor job mean (`stats.evals.*.metrics[].mean`) over `n_total_trials`. Errored trials count as **0 reward in that mean**, but they are **not** listed as reward 0.0 in the trial table — they are named exceptions. Also published: n_resolved/n_trials (reward 1.0 only). Absolute % is the **agent** (**terminus-2** + NVIDIA NIM `google/gemma-4-31b-it`), not Eden. Δ = on − off.",
  );
  const verdict = accuracyVerdict(r.delta.accuracy_pp);
  if (verdict) lines.push(verdict);
  lines.push(
    "Cost is NVIDIA hosted trial list ($0/MTok). Token counts are still reported. Not Friendli / third-party list price.",
  );
  lines.push("No BrainMemory column. No cortex-off. Not the 89-task tbench.ai board.");
  lines.push("");
  // --- M32.3 remain-silent measure (count only; omit gate is M38) ---
  lines.push(
    silenceNotes({
      date: r.date,
      offJob: r.off.job_dir,
      onJob: r.on.job_dir,
      tasks: r.tasks,
      accuracy_pp: r.delta.accuracy_pp,
      offLog: injectLogPath("off"),
      onLog: injectLogPath("on"),
    }).trimEnd(),
  );
  lines.push("");
  if (r.blockers.length) {
    lines.push("## Blockers");
    lines.push("");
    for (const b of r.blockers) lines.push(`- ${b}`);
    lines.push("");
  }
  for (const arm of [r.off, r.on] as const) {
    lines.push(`## Arm \`${arm.arm}\` (EDEN_MEMORY=${arm.eden_memory})`);
    lines.push("");
    lines.push(`Harbor ran: ${arm.harbor_ran ? "yes" : "no"}. Job dir: \`${arm.job_dir ?? "none"}\`.`);
    if (arm.error) lines.push(`Error: ${arm.error}`);
    lines.push("");
    if (arm.trials.length) {
      lines.push("| task | trial | reward | error | prompt tok | completion tok |");
      lines.push("|---|---|---|---|---|---|");
      for (const t of arm.trials) {
        const rewardCell = t.reward != null ? String(t.reward) : "n/a";
        lines.push(
          `| ${t.task} | ${t.trial} | ${rewardCell} | ${t.error ?? ""} | ${t.tokens.prompt} | ${t.tokens.completion} |`,
        );
      }
      lines.push("");
    } else {
      lines.push("No trial rows parsed.");
      lines.push("");
    }
  }
  lines.push("## How to re-run");
  lines.push("");
  lines.push("```bash");
  lines.push("bun benchmarks/terminal-bench/run.ts");
  lines.push("```");
  lines.push("");
  lines.push("Requires Docker, Harbor CLI, NVIDIA_API_KEY in gitignored `.env`. Never print the key.");
  lines.push("");
  if (r.notes.length) {
    lines.push("## Notes");
    lines.push("");
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  lines.push(
    "Cite: Terminal-Bench [arxiv:2601.11868]; memory exam slot [arxiv:2607.08716] via Plan §11.1. Harbor dataset: https://github.com/harbor-framework/terminal-bench-2-1",
  );
  lines.push("");
  return lines.join("\n");
}

async function runHarborArm(
  harbor: { cmd: string; prefix: string[] },
  arm: Arm,
  subset: Subset,
): Promise<{ code: number; jobDir: string | null; error?: string; stdout: string }> {
  const cfg = writeHarborConfig(arm, subset);
  const args = [
    ...harbor.prefix,
    "run",
    "--config",
    cfg,
    "-k",
    String(subset.k),
    "-n",
    String(Math.max(1, Number(process.env.TB_CONCURRENCY) || 1)),
    "-o",
    JOBS_DIR,
    "-y",
  ];
  const localBin = join(process.env.HOME || "", ".local/bin");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${localBin}:${process.env.PATH || ""}`,
    OPENAI_API_KEY: HARBOR_WRAP_KEY,
    OPENAI_BASE_URL: `${wrapOrigin()}/v1`,
    OPENAI_API_BASE: `${wrapOrigin()}/v1`,
  };
  delete env.NVIDIA_API_KEY;
  const logPath = join(HERE, `harbor-${arm}.log`);
  writeFileSync(logPath, `+ ${harbor.cmd} ${args.join(" ")}\n`);
  const code: number = await new Promise((resolve, reject) => {
    const child = spawn(harbor.cmd, args, { cwd: HERE, env, stdio: ["ignore", "pipe", "pipe"] });
    const onChunk = (b: Buffer) => {
      try {
        writeFileSync(logPath, b, { flag: "a" });
      } catch {}
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 1));
  });
  const jobDir = findJobDir(arm);
  const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-1200) : "";
  const err = code === 0 ? undefined : `harbor run arm=${arm} exit ${code}: ${tail}`;
  return { code, jobDir, error: err, stdout: tail };
}

async function harborVersion(h: { cmd: string; prefix: string[] }): Promise<string> {
  const r = await sh(h.cmd, [...h.prefix, "--version"]).catch(() => ({ stdout: "", stderr: "", code: 1 }));
  return (r.stdout || r.stderr).trim().split(/\n/)[0] || h.cmd;
}

export async function main(): Promise<RunReport> {
  loadDotenv(join(ROOT, ".env"));
  const subset = loadSubset();
  const blockers: string[] = [];
  const notes: string[] = [...LOCKED_NOTES];
  const report: RunReport = {
    wave: WAVE,
    date: new Date().toISOString().slice(0, 10),
    harness: "Harbor CLI + terminus-2 + Docker (timeout_multiplier=3.0)",
    harbor_cli: null,
    harbor_ran: false,
    harbor_dry_run: false,
    dataset: DATASET_HUB,
    dataset_source: "pending",
    public_board: false,
    n: subset.tasks.length,
    k: subset.k,
    model: modelId(),
    agent: "terminus-2",
    wrap: WRAP_INJECT,
    nim_base: nimBase(),
    reasoning_effort: "n/a",
    tasks: subset.tasks,
    nvidia_trial_usd_per_mtok: { input: 0, output: 0 },
    inject: null,
    off: parseArm("off", null, false),
    on: parseArm("on", null, false),
    delta: { accuracy_pp: null, tokens_total: null, dollars: 0 },
    blockers,
    notes,
  };

  const dock = await dockerOk();
  if (dock) blockers.push(`Docker: ${dock}`);

  let harborPath: { bin: string | null; error?: string } = { bin: null };
  try {
    harborPath = await ensureHarbor();
  } catch (e) {
    harborPath = { bin: null, error: String(e) };
  }
  if (!harborPath.bin) blockers.push(`Harbor CLI: ${harborPath.error || "install failed"}`);
  const hb = harborBin(harborPath);
  if (harborPath.bin) {
    report.harbor_cli = await harborVersion(hb);
  }

  const ds = await ensureDataset();
  report.dataset_source = ds.source;
  if (ds.error) blockers.push(`Dataset: ${ds.error}`);

  if (harborPath.bin && !ds.error) {
    const dry = await harborDryRun(hb, subset);
    if (dry) blockers.push(`Harbor dry-run: ${dry}`);
    else report.harbor_dry_run = true;
  }

  try {
    const nim = await probeNim();
    if (nim.sibling) notes.push(nim.sibling);
    if (nim.error) {
      const gw = /504|BadGateway|Bad Gateway|Gateway Timeout/i.test(nim.error);
      notes.push(
        `NVIDIA NIM preflight: ${nim.error}${gw ? " (504/BadGateway is not a skip)" : ""} (Harbor still launched; wrap probe retries)`,
      );
    }
  } catch (e) {
    blockers.push(`NVIDIA NIM: ${String(e)}`);
  }

  try {
    report.inject = await injectSelfCheck();
    notes.push(
      `Wrap injectBodyThenObserveTools: EDEN_MEMORY=0 identity=${report.inject.off_identity}; on mark=${report.inject.on_has_mark} fact=${report.inject.on_has_fact}.`,
    );
  } catch (e) {
    blockers.push(`inject self-check: ${String(e)}`);
  }

  const skip = process.env.TB_SKIP_HARBOR === "1";
  if (skip) {
    blockers.push("TB_SKIP_HARBOR=1 — Harbor jobs not launched");
  }

  const canRun =
    !skip && !blockers.some((b) => b.startsWith("Docker:") || b.startsWith("Harbor CLI:") || b.startsWith("Dataset:"));

  if (canRun) {
    for (const arm of ["off", "on"] as const) {
      let child: ChildProcess | undefined;
      try {
        wrapPort = await ensureWrapPort();
        let w = startWrap(arm);
        child = w.child;
        let boot = await waitWrap();
        if (boot) {
          stopChild(child);
          wrapPort = await ensureWrapPort();
          w = startWrap(arm);
          child = w.child;
          boot = await waitWrap();
          if (boot) notes.push(`wrap ${arm}: ${boot} (Harbor still launched)`);
        }
        const wrapChat = await probeWrap();
        if (wrapChat) {
          const gw = /HTTP 504|HTTP 502|BadGateway|Gateway Timeout/i.test(wrapChat);
          notes.push(
            `wrap ${arm} chat: ${wrapChat}${gw ? " (504/BadGateway is not a skip)" : ""} (Harbor still launched)`,
          );
        }
        const run = await runHarborArm(hb, arm, subset);
        const ran = harborRanFrom(run.jobDir, true);
        report[arm] = parseArm(arm, run.jobDir, ran, run.error);
        report.harbor_ran = report.harbor_ran || ran;
        if (run.error) blockers.push(run.error);
      } catch (e) {
        const msg = String(e);
        blockers.push(`arm ${arm}: ${msg}`);
        const dir = findJobDir(arm);
        report[arm] = parseArm(arm, dir, harborRanFrom(dir, Boolean(dir)), msg);
      } finally {
        stopChild(child);
        await killPortListeners(wrapPort);
        await Bun.sleep(400);
      }
    }
  } else {
    notes.push("Harbor jobs skipped because a named host blocker failed before launch.");
  }

  finishReport(report);
  return report;
}

function finishReport(report: RunReport): void {
  report.harbor_ran = report.off.harbor_ran || report.on.harbor_ran;
  const a0 = report.off.accuracy;
  const a1 = report.on.accuracy;
  report.delta.accuracy_pp = a0 != null && a1 != null ? Number((a1 - a0).toPrecision(12)) : null;
  report.delta.tokens_total =
    report.off.tokens.measured || report.on.tokens.measured ? report.on.tokens.total - report.off.tokens.total : null;
  report.delta.dollars = report.on.dollars - report.off.dollars;
  for (const n of memoryDeltaNotes(report.off, report.on)) {
    if (!report.notes.includes(n)) report.notes.push(n);
  }
  writeFileSync(LAST_RUN_PATH, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(RESULTS_PATH, renderResults(report));
}

/** Re-render RESULTS.md + .last-run.json from existing Harbor job dirs. Does not launch Harbor. */
export function reparseExisting(): RunReport {
  const subset = loadSubset();
  let prev: Partial<RunReport> = {};
  if (existsSync(LAST_RUN_PATH)) {
    try {
      prev = JSON.parse(readFileSync(LAST_RUN_PATH, "utf8")) as Partial<RunReport>;
    } catch {
      prev = {};
    }
  }
  const offDir = findJobDir("off");
  const onDir = findJobDir("on");
  const off = parseArm("off", offDir, harborRanFrom(offDir, Boolean(offDir)));
  const on = parseArm("on", onDir, harborRanFrom(onDir, Boolean(onDir)));
  const notes: string[] = [...LOCKED_NOTES];
  if (prev.inject) {
    notes.push(
      `Wrap injectBodyThenObserveTools: EDEN_MEMORY=0 identity=${prev.inject.off_identity}; on mark=${prev.inject.on_has_mark} fact=${prev.inject.on_has_fact}.`,
    );
  }
  notes.push("Re-rendered from existing Harbor job json. Harbor was not re-run.");
  const report: RunReport = {
    wave: WAVE,
    date: new Date().toISOString().slice(0, 10),
    harness: prev.harness ?? "Harbor CLI + terminus-2 + Docker (timeout_multiplier=3.0)",
    harbor_cli: prev.harbor_cli ?? null,
    harbor_ran: false,
    harbor_dry_run: prev.harbor_dry_run ?? true,
    dataset: prev.dataset ?? DATASET_HUB,
    dataset_source: prev.dataset_source ?? "pending",
    public_board: false,
    n: subset.tasks.length,
    k: subset.k,
    model: prev.model ?? NIM_MODEL,
    agent: prev.agent ?? "terminus-2",
    wrap: prev.wrap ?? WRAP_INJECT,
    nim_base: prev.nim_base ?? NIM_BASE,
    reasoning_effort: prev.reasoning_effort ?? "n/a",
    tasks: subset.tasks,
    nvidia_trial_usd_per_mtok: prev.nvidia_trial_usd_per_mtok ?? { input: 0, output: 0 },
    inject: prev.inject ?? null,
    off,
    on,
    delta: { accuracy_pp: null, tokens_total: null, dollars: 0 },
    blockers: [],
    notes,
  };
  finishReport(report);
  return report;
}

if (import.meta.main) {
  const reparse = process.argv.includes("--reparse") || process.env.TB_REPARSE === "1";
  const r = reparse ? reparseExisting() : await main();
  console.log(renderResults(r));
  if (!r.harbor_ran) process.exitCode = 2;
}
