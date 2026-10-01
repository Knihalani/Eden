/**
 * M26 LME-V2 Small runner (`formatResults` → RESULTS.md). Report §4.12.
 *
 *   bun benchmarks/lme-v2/run.ts
 *
 * Product path: openMemory inject (`src/index.ts`). Ingest each Small trajectory
 * via putExperience (AX `tree` on `{dir}/experience/*.jsonl`, never extractDurable),
 * optional short observe notes without AX trees (`omitExperienceTree`), then
 * `mem.sleep()` (M25 replay; files remain). Query =
 * inject([{role:"user",content:question}]). Reader = NVIDIA NIM Gemma 4 31B IT
 * (`google/gemma-4-31b-it`). Disclosed. Not 4o-mini. No memory_search.
 * No BrainMemory. No LoCoMo hay. Fail-open.
 *
 * Smoke ≠ official: `LME_LIMIT` or n<451 writes RESULTS.smoke.md NEVER
 * RESULTS.md. Only the full 451 writes RESULTS.md + last-run.json.
 * `EDEN_EXPERIENCE_BYTES` is set high enough for 200 traj files (default 32MiB
 * may evict). Do not raise `EDEN_MEMORY_STORE_CAP` as a fake haystack.
 * Do not invent 74.9. Acc is this run, not a costume of M15 2.7%.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import {
  EXPERIENCE_BYTES_ENV,
  ExperienceStore,
  omitExperienceTree,
  putExperience,
} from "../../src/experience-store.ts";
import { MEMORY_MARK, openMemory, type AgentMemory } from "../../src/index.ts";
import { goldInPacket, scorePrediction, extractBoxedAnswer, type JudgeFn } from "./score.ts";

export const HOLD_DIR = import.meta.dir;
export const DATA_DIR = join(HOLD_DIR, ".data");
export const RESULTS_PATH = join(HOLD_DIR, "RESULTS.md");
export const RESULTS_SMOKE_PATH = join(HOLD_DIR, "RESULTS.smoke.md");
export const LAST_RUN_PATH = join(HOLD_DIR, "last-run.json");
export const DEBUG_PATH = join(HOLD_DIR, "debug-sample.jsonl");
/** Official Small question count. Anything else is smoke. */
export const OFFICIAL_N = 451;
/**
 * Experience disk budget for 200 Small traj files. Default 32MiB may evict.
 * Distinct from JSONL `EDEN_MEMORY_STORE_CAP` — never raise that as a haystack.
 */
export const LME_EXPERIENCE_BYTES = 256 * 1024 * 1024;

export const DATASET_FILENAMES = {
  questions: "questions.jsonl",
  haystack: "haystacks/lme_v2_small.json",
  trajFull: "trajectories.jsonl",
  trajCompact: "trajectories.small-compact.jsonl",
} as const;

/** Orchestrator Blocked token: `error.name === "LmeDatasetMissingError"` + exact filename. */
export class LmeDatasetMissingError extends Error {
  readonly filename: string;
  constructor(filename: string) {
    super(`Blocked: LME dataset missing: ${filename}`);
    this.name = "LmeDatasetMissingError";
    this.filename = filename;
  }
}

/** Official = n===451 and `LME_LIMIT` unset/blank. `LME_LIMIT` or n<451 is smoke. */
export function isOfficialRun(n: number, limitEnv: string | undefined = process.env.LME_LIMIT): boolean {
  if (limitEnv != null && String(limitEnv).trim() !== "") return false;
  return n === OFFICIAL_N;
}

export function resultsPathFor(n: number, limitEnv: string | undefined = process.env.LME_LIMIT): string {
  return isOfficialRun(n, limitEnv) ? RESULTS_PATH : RESULTS_SMOKE_PATH;
}

export function shouldWriteLastRun(n: number, limitEnv: string | undefined = process.env.LME_LIMIT): boolean {
  return isOfficialRun(n, limitEnv);
}

/** Raise a tight/missing experience budget so 200 traj files are not evicted. Does not touch JSONL cap. */
export function ensureExperienceBudget(): number {
  const cur = Number(process.env[EXPERIENCE_BYTES_ENV]);
  if (!Number.isFinite(cur) || cur < LME_EXPERIENCE_BYTES) {
    process.env[EXPERIENCE_BYTES_ENV] = String(LME_EXPERIENCE_BYTES);
  }
  return Number(process.env[EXPERIENCE_BYTES_ENV]);
}

export function requireDatasetFile(absPath: string, filename: string): void {
  if (!existsSync(absPath)) throw new LmeDatasetMissingError(filename);
}

const HF = "https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/resolve/main";
const QUESTIONS_PATH = join(DATA_DIR, "questions.jsonl");
const HAYSTACK_PATH = join(DATA_DIR, "haystacks/lme_v2_small.json");
const TRAJ_FULL_PATH = join(DATA_DIR, "trajectories.jsonl");
const TRAJ_COMPACT_PATH = join(DATA_DIR, "trajectories.small-compact.jsonl");

export const RAG_SMALL = 42.8;
export const AGENTRUNBOOK_C_SMALL = 74.9;

/** Frozen M15.2 official Small — comparison only. Not this run's acc cell. */
export const M15_LOCK = {
  date: "2026-09-19",
  n: 451,
  n_correct: 12,
  acc_pct: "2.7",
  gold_hit: 73,
  gold_n: 226,
  gold_na: 225,
  packet_empty: 0,
  inject_p50: "82.0",
  inject_p95: "286.0",
} as const;

/** Early diagnostic, not official Small. Done-when: compare to ~3.5% @200. */
export const DIAGNOSTIC_200 = {
  n: 200,
  acc_pct: "~3.5",
} as const;
const TREE_CAP = Number(process.env.LME_TREE_CAP || 1200);
const THOUGHT_CAP = Number(process.env.LME_THOUGHT_CAP || 600);
const ACTION_CAP = Number(process.env.LME_ACTION_CAP || 400);
const STATE_CAP = Number(process.env.LME_STATE_CAP || 40);
const MAX_TOKENS_READER = Number(process.env.LME_READER_MAX_TOKENS || 512);
const MAX_TOKENS_JUDGE = Number(process.env.LME_JUDGE_MAX_TOKENS || 256);

type Question = {
  id: string;
  domain: "web" | "enterprise";
  environment: string;
  question_type: string;
  question: string;
  image: string | null;
  answer: string;
  eval_function: string;
};

type State = {
  url?: string;
  action?: unknown;
  thought?: unknown;
  accessibility_tree?: unknown;
};

type Trajectory = {
  id: string;
  domain: string;
  environment?: string;
  goal?: string;
  outcome?: string;
  start_url?: string;
  states?: State[];
};

export type CompactTraj = {
  id: string;
  domain: string;
  environment: string;
  goal: string;
  outcome: string;
  start_url: string;
  n_states_raw: number;
  n_states_kept: number;
  chars_raw_est: number;
  chars_kept: number;
  states: { url: string; action: string; thought: string; observation: string }[];
};

type DomainRun = {
  domain: string;
  traj_ids: string[];
  traj_found: number;
  states_kept: number;
  chars_kept: number;
  records_after_ingest: number;
  store_cap: number;
  experience_files: number;
  experience_bytes_cap: number;
  ingest_ms: number;
};

type Row = {
  id: string;
  domain: string;
  question_type: string;
  eval: string;
  image: boolean;
  packet_empty: boolean;
  packet_chars: number;
  gold_in_packet: boolean | null;
  reader_ok: boolean;
  inject_ms: number;
  reader_ms: number;
  query_ms: number;
  correct: boolean;
};

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function loadDotenv() {
  const p = join(HOLD_DIR, "../../.env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && process.env[k] == null) process.env[k] = v;
  }
}

const PINNED_NIM_MODEL = "google/gemma-4-31b-it";

function requireNim(): { base: string; model: string; key: string } {
  loadDotenv();
  const base = (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
  // Stale shell NIM_MODEL (glm / deepseek) must not win: those dumps thinking into
  // content and score as 0.0 even when the packet has gold.
  process.env.NIM_MODEL = PINNED_NIM_MODEL;
  const key = process.env.NVIDIA_API_KEY || "";
  if (!key || key.length < 8) throw new Error("NVIDIA_API_KEY missing from gitignored .env (not printed).");
  return { base, model: PINNED_NIM_MODEL, key };
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i]!;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Bounded pool. One HTTP 504 must not skip the remaining items. */
async function mapPool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const conc = Math.max(1, Math.min(items.length, Math.floor(n) || 1));
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  return out;
}

function readerConcurrency(): number {
  const n = Number(process.env.LME_READER_CONCURRENCY || 4);
  if (!Number.isFinite(n) || n < 1) return 4;
  return Math.min(8, Math.floor(n));
}

function loadQuestions(): Question[] {
  requireDatasetFile(QUESTIONS_PATH, DATASET_FILENAMES.questions);
  return readFileSync(QUESTIONS_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Question);
}

function loadHaystack(): Record<string, string[]> {
  requireDatasetFile(HAYSTACK_PATH, DATASET_FILENAMES.haystack);
  return JSON.parse(readFileSync(HAYSTACK_PATH, "utf8")) as Record<string, string[]>;
}

function uniqueTrajIds(hay: Record<string, string[]>): Set<string> {
  const s = new Set<string>();
  for (const ids of Object.values(hay)) for (const id of ids) s.add(id);
  return s;
}

function domainHaystacks(questions: Question[], hay: Record<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const q of questions) {
    if (out.has(q.domain)) continue;
    const ids = hay[q.id];
    if (ids?.length) out.set(q.domain, ids);
  }
  return out;
}

function compactOne(raw: Trajectory): CompactTraj {
  const states = Array.isArray(raw.states) ? raw.states : [];
  const kept = states.slice(0, STATE_CAP);
  let charsRaw = 0;
  let charsKept = 0;
  const outStates = kept.map((st) => {
    const url = asText(st.url);
    const action = clip(asText(st.action), ACTION_CAP);
    const thought = clip(asText(st.thought), THOUGHT_CAP);
    const observation = clip(asText(st.accessibility_tree), TREE_CAP);
    charsRaw +=
      asText(st.action).length + asText(st.thought).length + asText(st.accessibility_tree).length + url.length;
    charsKept += action.length + thought.length + observation.length + url.length;
    return { url, action, thought, observation };
  });
  for (const st of states.slice(STATE_CAP)) {
    charsRaw +=
      asText(st.action).length +
      asText(st.thought).length +
      asText(st.accessibility_tree).length +
      asText(st.url).length;
  }
  return {
    id: raw.id,
    domain: raw.domain,
    environment: String(raw.environment || ""),
    goal: String(raw.goal || ""),
    outcome: String(raw.outcome || ""),
    start_url: String(raw.start_url || ""),
    n_states_raw: states.length,
    n_states_kept: outStates.length,
    chars_raw_est: charsRaw,
    chars_kept: charsKept,
    states: outStates,
  };
}

async function ensureCoreFiles() {
  mkdirSync(join(DATA_DIR, "haystacks"), { recursive: true });
  if (!existsSync(QUESTIONS_PATH)) {
    try {
      const r = await fetch(`${HF}/questions.jsonl`);
      if (!r.ok) throw new LmeDatasetMissingError(DATASET_FILENAMES.questions);
      writeFileSync(QUESTIONS_PATH, Buffer.from(await r.arrayBuffer()));
    } catch (err) {
      if (err instanceof LmeDatasetMissingError) throw err;
      throw new LmeDatasetMissingError(DATASET_FILENAMES.questions);
    }
  }
  requireDatasetFile(QUESTIONS_PATH, DATASET_FILENAMES.questions);
  if (!existsSync(HAYSTACK_PATH)) {
    try {
      const r = await fetch(`${HF}/haystacks/lme_v2_small.json`);
      if (!r.ok) throw new LmeDatasetMissingError(DATASET_FILENAMES.haystack);
      writeFileSync(HAYSTACK_PATH, Buffer.from(await r.arrayBuffer()));
    } catch (err) {
      if (err instanceof LmeDatasetMissingError) throw err;
      throw new LmeDatasetMissingError(DATASET_FILENAMES.haystack);
    }
  }
  requireDatasetFile(HAYSTACK_PATH, DATASET_FILENAMES.haystack);
}

function compactReady(want: Set<string>): CompactTraj[] | null {
  if (!existsSync(TRAJ_COMPACT_PATH)) return null;
  const rows: CompactTraj[] = [];
  const have = new Set<string>();
  for (const line of readFileSync(TRAJ_COMPACT_PATH, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as CompactTraj;
    rows.push(row);
    have.add(row.id);
  }
  for (const id of want) if (!have.has(id)) return null;
  return rows;
}

async function streamCompactFrom(path: string, want: Set<string>): Promise<CompactTraj[]> {
  const rows: CompactTraj[] = [];
  const have = new Set<string>();
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (!line.includes('"id"')) continue;
    let raw: Trajectory;
    try {
      raw = JSON.parse(line) as Trajectory;
    } catch {
      continue;
    }
    if (!raw?.id || !want.has(raw.id) || have.has(raw.id)) continue;
    const c = compactOne(raw);
    rows.push(c);
    have.add(c.id);
    if (have.size >= want.size) break;
  }
  return rows;
}

async function waitForFullTrajectories(timeoutMs = 45 * 60 * 1000): Promise<string> {
  if (!existsSync(TRAJ_FULL_PATH)) throw new LmeDatasetMissingError(DATASET_FILENAMES.trajFull);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(TRAJ_FULL_PATH)) {
      const st = Bun.file(TRAJ_FULL_PATH).size;
      // Official HF listing is ~1.2GB (curl Total 1140M). Wait until the file is complete.
      if (st >= 1_190_000_000) return TRAJ_FULL_PATH;
    }
    await Bun.sleep(5000);
  }
  throw new LmeDatasetMissingError(DATASET_FILENAMES.trajFull);
}

async function ensureCompact(want: Set<string>): Promise<CompactTraj[]> {
  const existing = compactReady(want);
  if (existing) return existing;
  let path = TRAJ_FULL_PATH;
  if (!existsSync(path)) throw new LmeDatasetMissingError(DATASET_FILENAMES.trajFull);
  if (Bun.file(path).size < 1_190_000_000) {
    console.log("waiting for trajectories.jsonl (~1.2GB text; screenshots skipped)…");
    path = await waitForFullTrajectories();
  }
  console.log("compacting Small-tier unique trajectories (truncated AX trees)…");
  const rows = await streamCompactFrom(path, want);
  writeFileSync(TRAJ_COMPACT_PATH, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (!rows.length) throw new LmeDatasetMissingError(DATASET_FILENAMES.trajCompact);
  return rows;
}

/** Short episodic JSONL note: goal/outcome/url only. Never dump 40 AX trees into chat JSONL. */
function trajNote(traj: CompactTraj): { role: string; content: string }[] {
  const raw = {
    role: "user",
    content: `Colleague trajectory ${traj.id} in ${traj.environment || traj.domain}. Goal: ${traj.goal || "(none)"}. Outcome: ${traj.outcome || "unknown"}. Start: ${traj.start_url || ""}.`,
  };
  const stripped = omitExperienceTree(raw);
  if (stripped && typeof stripped === "object" && !Array.isArray(stripped)) {
    const o = stripped as { role?: unknown; content?: unknown };
    return [
      {
        role: typeof o.role === "string" ? o.role : "user",
        content: typeof o.content === "string" ? o.content : raw.content,
      },
    ];
  }
  return [raw];
}

function experienceFilesReadable(dir: string, expectIds: string[]): boolean {
  try {
    const store = new ExperienceStore(dir);
    for (const id of expectIds) {
      const traj = store.get(id);
      if (!traj || !Array.isArray(traj.states)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function ingestDomain(
  dir: string,
  trajs: CompactTraj[],
): Promise<{
  records: number;
  states: number;
  chars: number;
  ms: number;
  experience_files: number;
  experience_bytes_cap: number;
}> {
  mkdirSync(dir, { recursive: true });
  const bytesCap = ensureExperienceBudget();
  const mem = openMemory({ dir, session: "lme-v2-small" });
  const t0 = Date.now();
  let states = 0;
  let chars = 0;
  mem.quiet(() => {
    for (const traj of trajs) {
      states += traj.n_states_kept;
      chars += traj.chars_kept + traj.goal.length;
      putExperience(dir, {
        id: traj.id,
        session: "lme-v2-small",
        goal: traj.goal,
        outcome: traj.outcome,
        states: traj.states.map((st, t) => ({
          url: st.url,
          action: st.action,
          thought: st.thought,
          tree: st.observation,
          t,
        })),
      });
      mem.observe(trajNote(traj));
    }
  });
  await mem.sleep();
  const store = new ExperienceStore(dir);
  const experience_files = store.ids().length;
  if (trajs.length > 0 && (experience_files === 0 || !experienceFilesReadable(dir, store.ids()))) {
    mem.close();
    throw new Error("Blocked: experience/*.jsonl unreadable after sleep");
  }
  const records = mem.memories().length;
  mem.close();
  return { records, states, chars, ms: Date.now() - t0, experience_files, experience_bytes_cap: bytesCap };
}

function packetOf(injected: unknown[]): string {
  for (const m of injected) {
    if (!m || typeof m !== "object") continue;
    const o = m as { role?: string; content?: unknown };
    if (o.role === "system" && typeof o.content === "string" && o.content.includes(MEMORY_MARK)) return o.content;
  }
  return "";
}

function nimPost(
  nim: { base: string; model: string; key: string },
  body: string,
  timeoutMs: number,
  stream: boolean,
): Promise<{ status: number; text: string }> {
  const url = new URL(`${nim.base}/chat/completions`);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${nim.key}`,
          "Content-Type": "application/json",
          Accept: stream ? "text/event-stream" : "application/json",
          // Gemma 4 31B often needs >30s cold; poll=30 504s while poll=120 returns 200.
          "NVCF-POLL-SECONDS": process.env.NVCF_POLL_SECONDS || "120",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseSseContent(raw: string): string {
  const parts: string[] = [];
  const reason: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const data = t.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const j = JSON.parse(data) as {
        choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string } }[];
      };
      const d = j.choices?.[0]?.delta;
      if (d?.content) parts.push(d.content);
      if (d?.reasoning_content) reason.push(d.reasoning_content);
      else if (d?.reasoning) reason.push(d.reasoning);
    } catch {
      /* skip malformed SSE */
    }
  }
  return (parts.join("") || reason.join("")).trim();
}

async function nimChat(
  nim: { base: string; model: string; key: string },
  messages: { role: string; content: string }[],
  maxTokens: number,
  attempts = 3,
): Promise<{ text: string; ms: number }> {
  const t0 = Date.now();
  let lastErr = "";
  const timeoutMs = Number(process.env.LME_NIM_TIMEOUT_MS || 150_000);
  const payload = JSON.stringify({
    model: nim.model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
    stream: false,
  });
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: { status: number; text: string };
    try {
      res = await nimPost(nim, payload, timeoutMs, false);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : "fetch";
      await Bun.sleep(1000 * (attempt + 1));
      continue;
    }
    const ms = Date.now() - t0;
    if (res.status === 429 || res.status >= 500) {
      lastErr = `HTTP ${res.status}`;
      await Bun.sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      lastErr = `NIM HTTP ${res.status}`;
      await Bun.sleep(1000 * (attempt + 1));
      continue;
    }
    let text = "";
    try {
      const body = JSON.parse(res.text) as {
        choices?: { message?: { content?: string; reasoning_content?: string } }[];
      };
      const msg = body.choices?.[0]?.message;
      // Never treat reasoning_content as the answer — that is how GLM dumps scored 0/25.
      text = (msg?.content || "").trim();
    } catch {
      text = parseSseContent(res.text);
    }
    if (text) return { text, ms };
    lastErr = "NIM empty";
    await Bun.sleep(1000 * (attempt + 1));
  }
  throw new Error(`NIM failed after retries (${lastErr})`);
}

async function nimProbe(nim: {
  base: string;
  model: string;
  key: string;
}): Promise<{ ok: boolean; ms: number; note: string }> {
  const t0 = Date.now();
  try {
    const r = await nimChat(nim, [{ role: "user", content: "Reply with the single word pong." }], 16, 2);
    const text = r.text.trim();
    const ok = /^\s*pong\s*$/i.test(text) || /^\\boxed\{\s*pong\s*\}\s*$/i.test(text);
    return { ok, ms: r.ms, note: `${nim.model} ${JSON.stringify(text).slice(0, 80)}` };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, note: err instanceof Error ? err.message : "fail" };
  }
}

function readerPrompt(question: string, packet: string): { role: string; content: string }[] {
  const mem = packet.trim() || "(empty — no Eden Memory packet)";
  return [
    {
      role: "system",
      content:
        "You answer LongMemEval-V2 questions using only the Eden Memory packet. If the packet does not contain enough evidence, answer UNKNOWN. Output only \\boxed{final answer} with no analysis.",
    },
    {
      role: "user",
      content: `Eden Memory packet:\n${mem}\n\nQuestion:\n${question}\n\nMark your final answer in \\boxed{}.`,
    },
  ];
}

function storeCap(): number {
  return Number(process.env.EDEN_MEMORY_STORE_CAP) || 2000;
}

function kCap(): number {
  return Number(process.env.EDEN_MEMORY_CAP) || 6;
}

function countExperienceFiles(root: string): number {
  try {
    const d = join(root, "experience");
    if (!existsSync(d)) return 0;
    return readdirSync(d).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

/** Plan §9.2: SOTA agent-trajectory memory only if acc ≥ AgentRunbook-C. Overall WIN only if both targets WIN. */
export function verdict(accPct: number): {
  vs_rag: "WIN" | "LOSS";
  vs_agentrunbook_c: "WIN" | "LOSS";
  overall: "WIN" | "LOSS";
} {
  const vs_rag = accPct + 1e-9 >= RAG_SMALL ? "WIN" : "LOSS";
  const vs_agentrunbook_c = accPct + 1e-9 >= AGENTRUNBOOK_C_SMALL ? "WIN" : "LOSS";
  return { vs_rag, vs_agentrunbook_c, overall: vs_rag === "WIN" && vs_agentrunbook_c === "WIN" ? "WIN" : "LOSS" };
}

export function formatResults(args: {
  date: string;
  bun: string;
  nim_model: string;
  n: number;
  n_correct: number;
  acc: number;
  reader_ok: boolean;
  reader_note: string;
  gold_in_packet: { n: number; hit: number };
  reader_answered: number;
  inject: number[];
  reader: number[];
  query: number[];
  packet_empty: number;
  domains: DomainRun[];
  by_type: Record<string, { n: number; correct: number }>;
  ingested: {
    questions: number;
    unique_traj: number;
    screenshots: "skipped";
    full_tokens_claimed: string;
    what_ran: string;
  };
  v: ReturnType<typeof verdict>;
  /** ExperienceStore traj files written this run (0 = product store exists; this ingest may still be observe-only). */
  experience_files?: number;
}): string {
  const pct = (x: number) => x.toFixed(1);
  const accPct = args.acc * 100;
  const goldNa = Math.max(0, args.n - args.gold_in_packet.n);
  const readerFail = Math.max(0, args.n - args.reader_answered);
  const typeRows = Object.entries(args.by_type)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, s]) => `| ${t} | ${s.n} | ${s.correct} | ${pct((100 * s.correct) / Math.max(1, s.n))} |`)
    .join("\n");
  const domRows = args.domains
    .map(
      (d) =>
        `| ${d.domain} | ${d.traj_found}/${d.traj_ids.length} | ${d.states_kept} | ${d.chars_kept} ` +
        `| ${d.records_after_ingest} / ${d.store_cap} | ${d.experience_files ?? 0} ` +
        `| ${(d.ingest_ms / 1000).toFixed(1)}s |`,
    )
    .join("\n");
  const goldRate = args.gold_in_packet.n ? `${pct((100 * args.gold_in_packet.hit) / args.gold_in_packet.n)}%` : "n/a";
  const emptyHonesty =
    "honest: files/silent slice can retrieve or miss; junk always-on is not assumed; non-empty ≠ gold";
  const experienceFiles = args.experience_files ?? args.domains.reduce((n, d) => n + (d.experience_files || 0), 0);
  const filesLine =
    experienceFiles > 0
      ? `1. **Files exist.** \`putExperience\` wrote ${experienceFiles} trajectory files (\`experience/*.jsonl\`, AX \`tree\`, not extractDurable). Inject is silent \`[episode]\` slices (k≤${kCap()}), not a file-walking coding-agent memory controller. Still **${args.v.overall}** vs RAG ${RAG_SMALL} and AgentRunbook-C ${AGENTRUNBOOK_C_SMALL} (Plan §9.2).`
      : `1. **Files exist.** ExperienceStore landed (M23); inject is silent \`[episode]\` slices (M24). This ingest must write \`experience/*.jsonl\` via \`putExperience\` — empty files here is a runner bug, not "No files" product. Still **${args.v.overall}** vs RAG ${RAG_SMALL} and AgentRunbook-C ${AGENTRUNBOOK_C_SMALL} (Plan §9.2).`;
  const overallWhy =
    args.v.overall === "WIN"
      ? `Acc ${pct(accPct)} meets RAG ${RAG_SMALL} and AgentRunbook-C ${AGENTRUNBOOK_C_SMALL}. Plan §9.2 SOTA agent-trajectory memory only at ≥ ${AGENTRUNBOOK_C_SMALL}.`
      : `Overall WIN only if both rows WIN. Target first ≥ RAG ${RAG_SMALL}, then AgentRunbook-C ${AGENTRUNBOOK_C_SMALL} (Plan §9.2).`;
  const readerProbe = args.reader_ok
    ? "NIM answered."
    : `NIM unavailable (${args.reader_note}). Probe does not skip remaining questions; each row still goes to the per-question reader. HTTP 504 scores that row incorrect and CONTINUE.`;
  return (
    `# M26 LME-V2 Small RESULTS

**Date:** ${args.date}
**ISO date:** ${args.date}
**Wave:** M26.2
**M37 recert:** ${args.date} — live n=${args.n} after M16–M36; trajectory SOTA only if acc ≥ ${AGENTRUNBOOK_C_SMALL}
**Report:** §11.1
**Bun:** ${args.bun}
**API under test:** \`openMemory\` inject (\`src/index.ts\`). Ingest = \`putExperience\` (AX \`tree\` on \`{dir}/experience/*.jsonl\`) + optional short observe notes (goal/outcome/url only, \`omitExperienceTree\`) + \`mem.sleep()\`. Query = \`inject([{role:"user",content:question}])\`. Packet = \`${MEMORY_MARK}\`.
**Reader:** NVIDIA NIM \`${args.nim_model}\` at \`NVIDIA_BASE_URL\` (key from gitignored \`.env\`, not printed). Probe: ${args.reader_ok ? "ok" : `unavailable (${args.reader_note})`}. Probe failure does not skip the question loop.
**k:** product default ${kCap()} (\`EDEN_MEMORY_CAP\`). **JSONL store cap:** product default ${storeCap()} (\`EDEN_MEMORY_STORE_CAP\`) — not raised as a fake haystack.
**Experience disk cap:** \`${EXPERIENCE_BYTES_ENV}\` (this runner sets ${LME_EXPERIENCE_BYTES} bytes if unset/tight; default 32MiB may evict 200 traj files).
**Chat-only:** no \`[procedure]\` mint. No \`memory_search\`. No BrainMemory.

Official Small: 100-trajectory haystack ~25M tokens, 451 questions. HuggingFace \`xiaowu0162/longmemeval-v2\`. M26 re-exam is after ExperienceStore files + silent slice inject (M23–M25). Official close is live n=451 — do not copy M15 **${M15_LOCK.acc_pct}%** into this acc cell.

## Headline

| metric | value |
|---|---|
| n | **${args.n}** |
| correct | ${args.n_correct} |
| **acc** | **${pct(accPct)}%** |
| inject p50 / p95 | ${pct(percentile(args.inject, 50))} / ${pct(percentile(args.inject, 95))} ms |
| reader p50 / p95 | ${pct(percentile(args.reader, 50))} / ${pct(percentile(args.reader, 95))} ms |
| query (inject+reader) p50 / p95 / mean | ${pct(percentile(args.query, 50))} / ${pct(percentile(args.query, 95))} / ${pct(mean(args.query))} ms |
| empty packets | ${args.packet_empty} / ${args.n} (${emptyHonesty}) |
| gold_in_packet hit / phrase-match denom | ${args.gold_in_packet.hit} / ${args.gold_in_packet.n} of ${args.n} (${goldRate}; ${goldNa} N/A llm/mc — not a sample) |
| reader answered | ${args.reader_answered} / ${args.n} (${readerFail} HTTP errors scored incorrect) |

## vs M15 / diagnostic (Report §11.1)

| baseline | n | acc | gold_in_packet | empty packets |
|---|---:|---:|---|---|
| M15.2 official Small | ${M15_LOCK.n} | ${M15_LOCK.acc_pct}% | ${M15_LOCK.gold_hit} / ${M15_LOCK.gold_n} phrase-match (${M15_LOCK.gold_na} N/A) | ${M15_LOCK.packet_empty} / ${M15_LOCK.n} (junk always-on then) |
| diagnostic | ${DIAGNOSTIC_200.n} | ${DIAGNOSTIC_200.acc_pct}% | — | — |
| this run (M26) | ${args.n} | ${pct(accPct)}% | ${args.gold_in_packet.hit} / ${args.gold_in_packet.n} phrase-match | ${args.packet_empty} / ${args.n} |

Compare explicitly: this run vs M15 official **${M15_LOCK.acc_pct}% @${M15_LOCK.n}** and the **${DIAGNOSTIC_200.acc_pct}% @${DIAGNOSTIC_200.n}** diagnostic. Official close is n=451 only. Do not treat the diagnostic as Small.

## Verdict

| target | published | this run | verdict |
|---|---:|---:|---|
| RAG query→slice | ${RAG_SMALL} | ${pct(accPct)} | **${args.v.vs_rag}** |
| AgentRunbook-C | ${AGENTRUNBOOK_C_SMALL} | ${pct(accPct)} | **${args.v.vs_agentrunbook_c}** |

**Overall: ${args.v.overall}.** Do not invent ${AGENTRUNBOOK_C_SMALL}. Verdict is vs published RAG ${RAG_SMALL} / AgentRunbook-C ${AGENTRUNBOOK_C_SMALL}, not vs M15 ${M15_LOCK.acc_pct}%. ${overallWhy}

## Honesty (do not green-wash)

**gold_in_packet denominator.** ${args.gold_in_packet.hit}/${args.gold_in_packet.n} is **not** a ${args.gold_in_packet.n}-question sample of n=${args.n}. \`goldInPacket\` only scores phrase-match \`eval_function\`s (\`norm_phrase_set_match\` + \`norm_phrase_set_match_ordered\`). llm/mc are N/A (null), not skipped. All ${args.n} questions were queried; ${goldNa} llm_*/mc_* rows are N/A.

**empty packets ${args.packet_empty}/${args.n}.** ${emptyHonesty}. Retrieval honesty is gold_in_packet hit / phrase-match denominator, not empty-packet count. 0 empty does not prove junk always-on.

**screenshots skipped (named).** Official Small includes HF \`trajectory_screenshots\` (~7GB remainder) and 29 question images (\`errors-gotchas\`). This run is text-only. Do not treat ${pct(accPct)}% as comparable to AgentRunbook-C ${AGENTRUNBOOK_C_SMALL} on multimodal gotchas.

**backbone.** NVIDIA NIM \`${args.nim_model}\`. Not 4o-mini. Not BrainMemory.

**reader errors.** ${args.reader_answered}/${args.n} NIM answered. ${readerFail}/${args.n} scored incorrect after reader HTTP errors. Acc is still ${args.n_correct}/${args.n}.

## M25 screenshot policy (2026-09-20)

The 29 \`errors-gotchas\` questions are multimodal. Policy: **skipped (named LOSS)** — HF \`trajectory_screenshots\` (~7GB remainder) and the 29 question images were not downloaded, not stored, and not replayed by sleep. If a host supplies alt-text/captions, those may be stored as text; this run did not ingest screenshots. Sleep (M25) replays experience **text files** into gists/how-to; files remain. That is not AgentRunbook-C **${AGENTRUNBOOK_C_SMALL}**. Do not treat any current acc as comparable to ${AGENTRUNBOOK_C_SMALL} on multimodal gotchas (Report §4.12).

## M26.3 latency

Live-run inject (this file) vs filed clocks. **Different fixtures — do not collapse them.**

| clock | inject p50 | inject p95 | fixture |
|---|---:|---:|---|
| this LME run | ${pct(percentile(args.inject, 50))} | ${pct(percentile(args.inject, 95))} | ExperienceStore files + short JSONL notes; in-process inject |
| M15 LME | 82 | 286 | 2000 JSONL records (observe-only; no experience files) |
| M6.4 | 0.048 | 0.133 | 5-message fixture, N=80 (\`BASELINE.md\`) |

Wrap inject is in-process \`AgentMemory.inject\`, not a 60ms CLI. M6.4 remains the small-store baseline. LME p95 is haystack retrieve, not a CLI gate.

## What was actually ingested

${args.ingested.what_ran}

| | |
|---|---|
| questions.jsonl | ${args.ingested.questions} questions (official 451) |
| unique Small traj ids | ${args.ingested.unique_traj} (2 shared 100-traj haystacks: web + enterprise) |
| screenshots | **${args.ingested.screenshots}** (HF trajectory_screenshots + 29 question images not used) |
| official haystack size | ${args.ingested.full_tokens_claimed} — **not ingested** |
| store after ingest | JSONL notes are short (goal/outcome/url); cap ${storeCap()} is not the haystack. Experience files: see domain table. Disk cap \`${EXPERIENCE_BYTES_ENV}\`=${LME_EXPERIENCE_BYTES} (raised if tight) |
| truncation | accessibility_tree ${TREE_CAP} chars, thought ${THOUGHT_CAP}, action ${ACTION_CAP}, states/traj ≤ ${STATE_CAP} |

| domain | traj found | states kept | chars kept | jsonl / cap | experience files | ingest |
|---|---|---|---|---|---|---|
${domRows}

## Accuracy by question_type

| type | n | correct | acc % |
|---|---:|---:|---:|
${typeRows}

## Diagnosis (why ${args.v.overall})

${filesLine}
2. **Screenshots skipped (named).** Gotchas (n=29) are multimodal; this run is text-only. That is not AgentRunbook-C ${AGENTRUNBOOK_C_SMALL}.
3. **Truncation.** accessibility_tree ${TREE_CAP} chars, thought ${THOUGHT_CAP}, action ${ACTION_CAP}, states/traj ≤ ${STATE_CAP}. Official Small ~25M tokens not ingested.
4. **k.** Product default ${kCap()} (\`EDEN_MEMORY_CAP\`). Silent slices add a small extra budget; not k=40 MCC.
5. **Backbone.** NVIDIA NIM \`${args.nim_model}\`. Not 4o-mini. Not BrainMemory.
6. **Chat-only / no \`memory_search\`.** Reader sees only the inject packet. Store cap ${storeCap()} still evicts JSONL; experience disk cap is distinct (\`EDEN_EXPERIENCE_BYTES\`).
7. **Reader probe:** ${readerProbe}

## How to re-run

\`\`\`bash
bun benchmarks/lme-v2/run.ts
\`\`\`

Data cache: \`benchmarks/lme-v2/.data/\` (gitignored). Do not retune \`src/index.ts\` from this number. Schema is this file + \`last-run.json\`, not M15.1 MAB JSON. Smoke (\`LME_LIMIT\`) ≠ official.

## M15 lock appendix (${M15_LOCK.date})

Frozen M15.2 official Small (**not** this run): n=${M15_LOCK.n}, correct=${M15_LOCK.n_correct}, ` +
    `acc=**${M15_LOCK.acc_pct}%**, gold_in_packet **${M15_LOCK.gold_hit} / ${M15_LOCK.gold_n}** ` +
    `phrase-match (${M15_LOCK.gold_na} llm/mc N/A), empty **${M15_LOCK.packet_empty} / ${M15_LOCK.n}** ` +
    `(junk always-on then). inject p50/p95 ${M15_LOCK.inject_p50}/${M15_LOCK.inject_p95} ms. Reader ` +
    `\`google/gemma-4-31b-it\`. Overall LOSS vs RAG ${RAG_SMALL} and ` +
    `AgentRunbook-C ${AGENTRUNBOOK_C_SMALL}. Do not copy these cells into the M26 headline.
`
  );
}

async function main() {
  const nim = requireNim();
  ensureExperienceBudget();
  await ensureCoreFiles();
  const questions = loadQuestions().slice(0, Number(process.env.LME_LIMIT) || undefined);
  const hay = loadHaystack();
  if (questions.length !== OFFICIAL_N) console.warn(`questions.jsonl n=${questions.length} (official ${OFFICIAL_N})`);
  const want = uniqueTrajIds(hay);
  const compact = await ensureCompact(want);
  const byId = new Map(compact.map((t) => [t.id, t]));
  const domains = domainHaystacks(questions, hay);
  const work = join(tmpdir(), `eden-lme-v2-${Date.now().toString(36)}`);
  mkdirSync(work, { recursive: true });

  const domainRuns: DomainRun[] = [];
  const memByDomain = new Map<string, { dir: string; mem: AgentMemory }>();
  for (const [domain, ids] of domains) {
    const dir = join(work, domain);
    const trajs = ids.map((id) => byId.get(id)).filter((t): t is CompactTraj => !!t);
    console.log(`ingest ${domain}: ${trajs.length}/${ids.length} traj → putExperience + sleep`);
    const ing = await ingestDomain(dir, trajs);
    domainRuns.push({
      domain,
      traj_ids: ids,
      traj_found: trajs.length,
      states_kept: ing.states,
      chars_kept: ing.chars,
      records_after_ingest: ing.records,
      store_cap: storeCap(),
      experience_files: ing.experience_files,
      experience_bytes_cap: ing.experience_bytes_cap,
      ingest_ms: ing.ms,
    });
    memByDomain.set(domain, { dir, mem: openMemory({ dir, session: "lme-v2-small" }) });
  }
  const experience_files =
    domainRuns.reduce((n, d) => n + d.experience_files, 0) ||
    [...memByDomain.values()].reduce((n, h) => n + countExperienceFiles(h.dir), 0);

  const judge: JudgeFn = async ({ system, user }) => {
    const r = await nimChat(
      nim,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      MAX_TOKENS_JUDGE,
    );
    return r.text;
  };

  console.log("NIM probe…");
  const probe = await nimProbe(nim);
  console.log(`NIM probe ${probe.ok ? "ok" : "fail"} ${probe.ms}ms ${probe.note.slice(0, 80)}`);
  // Probe failure is diagnostic only. Never skip the remaining n questions.
  // HTTP 504 on one question scores that row incorrect and CONTINUE.

  type Pending = {
    q: Question;
    i: number;
    packet: string;
    inject_ms: number;
    gold_in_packet: boolean | null;
  };
  const pending: Pending[] = [];
  if (existsSync(DEBUG_PATH))
    try {
      writeFileSync(DEBUG_PATH, "");
    } catch {}
  let i = 0;
  for (const q of questions) {
    i++;
    const handle = memByDomain.get(q.domain);
    if (!handle) throw new Error(`no memory for domain ${q.domain}`);
    const tInject = Date.now();
    const injected = handle.mem.inject([{ role: "user", content: q.question }]) as {
      role?: string;
      content?: string;
    }[];
    const inject_ms = Date.now() - tInject;
    const packet = packetOf(injected);
    pending.push({
      q,
      i,
      packet,
      inject_ms,
      gold_in_packet: goldInPacket(q.eval_function, packet, q.answer),
    });
  }
  for (const h of memByDomain.values()) h.mem.close();

  const conc = readerConcurrency();
  console.log(
    `inject done n=${pending.length}; per-question reader pool ${conc} (HTTP 504 scores that row incorrect and CONTINUE)`,
  );
  let scored = 0;
  const rows: Row[] = await mapPool(pending, conc, async (p) => {
    const { q, packet, inject_ms, gold_in_packet } = p;
    let reader_ms = 0;
    let reader_ok = false;
    let prediction = "";
    try {
      const r = await nimChat(nim, readerPrompt(q.question, packet), MAX_TOKENS_READER);
      reader_ms = r.ms;
      prediction = r.text || "UNKNOWN";
      reader_ok = prediction.length > 0 && !/^UNKNOWN \(NIM reader unavailable\)/.test(prediction);
    } catch (err) {
      // HTTP 504 / reader failure: this row incorrect; do not break/return (never skip-all).
      prediction = `UNKNOWN (reader error: ${err instanceof Error ? err.message : "fail"})`;
      reader_ok = false;
    }
    let correct = false;
    if (reader_ok) {
      try {
        correct = await scorePrediction({
          spec: q.eval_function,
          prediction,
          answer: q.answer,
          question: q.question,
          judge,
        });
      } catch {
        correct = false;
      }
    }
    const boxed = extractBoxedAnswer(prediction);
    const nDone = ++scored;
    if (p.i <= 15 || nDone % 25 === 0 || nDone === pending.length) {
      console.log(
        `query ${nDone}/${pending.length} ${correct ? "Y" : "n"} gold_in_packet=${gold_in_packet} ` +
          `reader_ok=${reader_ok} boxed=${JSON.stringify(boxed).slice(0, 80)} ` +
          `pred=${JSON.stringify(prediction).slice(0, 100)}`,
      );
      try {
        writeFileSync(
          DEBUG_PATH,
          JSON.stringify({
            i: p.i,
            id: q.id,
            type: q.question_type,
            eval: q.eval_function.split("|")[0],
            gold: q.answer,
            gold_in_packet,
            reader_ok,
            correct,
            boxed: boxed.slice(0, 200),
            pred: prediction.slice(0, 240),
            packet_chars: packet.length,
            model: nim.model,
          }) + "\n",
          { flag: "a" },
        );
      } catch {}
    }
    return {
      id: q.id,
      domain: q.domain,
      question_type: q.question_type,
      eval: q.eval_function.split("|")[0]!,
      image: !!q.image,
      packet_empty: !packet.replace(MEMORY_MARK, "").trim(),
      packet_chars: packet.length,
      gold_in_packet,
      reader_ok,
      inject_ms,
      reader_ms,
      query_ms: inject_ms + reader_ms,
      correct,
    } satisfies Row;
  });

  const n = rows.length;
  const n_correct = rows.filter((r) => r.correct).length;
  const acc = n ? n_correct / n : 0;
  const v = verdict(acc * 100);
  const by_type: Record<string, { n: number; correct: number }> = {};
  for (const r of rows) {
    const s = (by_type[r.question_type] ??= { n: 0, correct: 0 });
    s.n++;
    if (r.correct) s.correct++;
  }
  const ingestedWhat = [
    `Downloaded official \`questions.jsonl\` + \`haystacks/lme_v2_small.json\` + trajectories text.`,
    `Did **not** download screenshot tarballs (~7GB dataset remainder).`,
    `Kept only the ${want.size} unique Small-tier trajectory ids, truncated per-state text, then \`putExperience\` (AX \`tree\` on \`experience/*.jsonl\`) + short observe notes (goal/outcome/url only, \`omitExperienceTree\`) + \`mem.sleep()\`.`,
    `JSONL store cap ${storeCap()} (\`EDEN_MEMORY_STORE_CAP\`) is **not** raised as a fake haystack. Experience disk cap \`${EXPERIENCE_BYTES_ENV}\`=${ensureExperienceBudget()} (default 32MiB may evict 200 traj files).`,
    compact.length < want.size
      ? `Missing ${want.size - compact.length} trajectories from the JSONL stream.`
      : `All ${want.size} unique Small traj ids were present in trajectories.jsonl.`,
  ].join(" ");

  const payload = {
    schema: "eden.lme-v2.small.v2",
    part: "M26",
    date: new Date().toISOString().slice(0, 10),
    bun: Bun.version,
    api_under_test: "openMemory.inject",
    reader: nim.model,
    k: kCap(),
    store_cap: storeCap(),
    experience_bytes: ensureExperienceBudget(),
    experience_bytes_env: EXPERIENCE_BYTES_ENV,
    n,
    n_correct,
    acc,
    acc_pct: acc * 100,
    latency_ms: {
      inject_p50: percentile(
        rows.map((r) => r.inject_ms),
        50,
      ),
      inject_p95: percentile(
        rows.map((r) => r.inject_ms),
        95,
      ),
      reader_p50: percentile(
        rows.map((r) => r.reader_ms),
        50,
      ),
      reader_p95: percentile(
        rows.map((r) => r.reader_ms),
        95,
      ),
      query_p50: percentile(
        rows.map((r) => r.query_ms),
        50,
      ),
      query_p95: percentile(
        rows.map((r) => r.query_ms),
        95,
      ),
      query_mean: mean(rows.map((r) => r.query_ms)),
    },
    packet_empty: rows.filter((r) => r.packet_empty).length,
    reader_answered: rows.filter((r) => r.reader_ok).length,
    gold_in_packet: {
      n: rows.filter((r) => r.gold_in_packet != null).length,
      hit: rows.filter((r) => r.gold_in_packet === true).length,
      na: rows.filter((r) => r.gold_in_packet == null).length,
      denominator: "phrase-match evals only (all applicable of n; llm/mc N/A; not a sample)",
    },
    compare: {
      m15_official: {
        n: M15_LOCK.n,
        acc_pct: M15_LOCK.acc_pct,
        gold_in_packet: `${M15_LOCK.gold_hit}/${M15_LOCK.gold_n} phrase-match`,
        empty: `${M15_LOCK.packet_empty}/${M15_LOCK.n}`,
      },
      diagnostic_200: { n: DIAGNOSTIC_200.n, acc_pct: DIAGNOSTIC_200.acc_pct },
    },
    honesty: {
      empty_packets:
        "honest count / n; junk always-on is not assumed after experience files + silent slice; non-empty ≠ gold",
      gold_denominator: "phrase-match evals only (all applicable of n; llm/mc N/A; not a sample)",
      screenshots: "skipped (named): HF trajectory_screenshots + 29 question images unused",
      backbone: nim.model,
    },
    reader_probe: { ok: probe.ok, ms: probe.ms, note: probe.note.slice(0, 120) },
    targets: { rag_small: RAG_SMALL, agentrunbook_c_small: AGENTRUNBOOK_C_SMALL },
    verdict: v,
    ingested: {
      questions: questions.length,
      unique_traj: want.size,
      traj_compact: compact.length,
      screenshots: "skipped" as const,
      full_tokens_claimed: "~25M official Small (not ingested)",
      tree_cap: TREE_CAP,
      thought_cap: THOUGHT_CAP,
      action_cap: ACTION_CAP,
      state_cap: STATE_CAP,
      domains: domainRuns,
    },
    by_type,
    rows,
  };

  const outPath = resultsPathFor(n);
  if (shouldWriteLastRun(n)) {
    writeFileSync(LAST_RUN_PATH, JSON.stringify(payload, null, 2));
  }
  writeFileSync(
    outPath,
    formatResults({
      date: payload.date,
      bun: payload.bun,
      nim_model: nim.model,
      n,
      n_correct,
      acc,
      reader_ok: probe.ok,
      reader_note: probe.note.slice(0, 120),
      gold_in_packet: {
        n: rows.filter((r) => r.gold_in_packet != null).length,
        hit: rows.filter((r) => r.gold_in_packet === true).length,
      },
      reader_answered: rows.filter((r) => r.reader_ok).length,
      inject: rows.map((r) => r.inject_ms),
      reader: rows.map((r) => r.reader_ms),
      query: rows.map((r) => r.query_ms),
      packet_empty: payload.packet_empty,
      domains: domainRuns,
      by_type,
      ingested: {
        questions: questions.length,
        unique_traj: want.size,
        screenshots: "skipped",
        full_tokens_claimed: "~25M tokens",
        what_ran: ingestedWhat,
      },
      v,
      experience_files,
    }),
  );
  console.log(`acc=${(acc * 100).toFixed(1)}% n=${n} ${v.overall} → ${outPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
