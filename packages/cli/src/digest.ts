/**
 * Weekly digest CLI (Wave 8.4). Mirrors Home tiles. Opt-in. Never emails.
 *
 * Default off: `digest is off` and exit 0. Enable with EDEN_DIGEST=1 or
 * config `digest: true`. Fetch failure renders EMPTY_DIGEST zeros (fail-open).
 */
import { writeFileSync } from "node:fs";
import { providerCacheHitInput, refusalStatus, type RefusalCode } from "@eden/ir";
import {
  EMPTY_DIGEST,
  addTokenClasses,
  asTokenClasses,
  cacheHitPctOf,
  dcPct as dcPctOf,
  emptyTokenClasses,
  rankByWaste,
  renderDigestHtml,
  renderDigestText,
  stretchWordsByTool,
  type DigestInput,
  type DigestNovelty,
  type DigestStretch,
} from "@eden/measure";
import { readConfig, resolveApiKey, wrapPlaneUrl, type Config } from "./home";

const DEMO_IDS = new Set(["cand_resolve", "cand_pending", "cand_refused", "live_notify", "live_paused"]);

export type InboxSlice = {
  candidates?: unknown[];
  live?: unknown[];
  savings?: { tokensSavedMean?: number };
};

export function digestHelp(): string {
  return `eden digest — weekly letter that mirrors Home

  eden digest            Text letter (default)
  eden digest --html     HTML letter
  eden digest --out file Write the letter to a file

Default off. Enable with EDEN_DIGEST=1 or config digest:true.
When off: prints "digest is off" and exits 0. Never sends mail.
A broken fetch prints honest zeros and never breaks the agent.
`;
}

export function digestOptedIn(cfg: Config | null = readConfig()): boolean {
  if (process.env.EDEN_DIGEST === "0") return false;
  if (process.env.EDEN_DIGEST === "1") return true;
  return cfg?.digest === true;
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function startOfLocalDay(ms: number): Date {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day;
}

function dayKey(day: Date): string {
  return `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
}

/** Same DC window Home uses: local days, unmeasured days are 0 / measured:false. */
export function dcFromReceipts(
  receipts: unknown[],
  now = Date.now(),
): { dcPct: number | null; dcSeries: DigestInput["dcSeries"] } {
  const days = 7;
  const start = startOfLocalDay(now);
  start.setDate(start.getDate() - (days - 1));
  const buckets = Array.from({ length: days }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return {
      key: dayKey(day),
      label: day.toLocaleDateString("en-US", { weekday: "short" }),
      classes: emptyTokenClasses(),
      measured: false,
    };
  });
  const index = new Map(buckets.map((bucket, i) => [bucket.key, i]));
  for (const raw of receipts) {
    const row = asRecord(raw);
    if (!row) continue;
    if (typeof row.tool_id === "string" && DEMO_IDS.has(row.tool_id)) continue;
    const classes = asTokenClasses(row.tokenClasses) ?? asTokenClasses(row.classes);
    if (!classes) continue;
    const t = Number(row.created_at);
    if (!Number.isFinite(t) || t <= 0) continue;
    const i = index.get(dayKey(new Date(t)));
    if (i == null) continue;
    addTokenClasses(buckets[i]!.classes, classes);
    buckets[i]!.measured = true;
  }
  const dcSeries = buckets.map((bucket) => ({
    label: bucket.label,
    dcPct: bucket.measured ? dcPctOf(bucket.classes) : 0,
    measured: bucket.measured,
  }));
  const measured = buckets.filter((bucket) => bucket.measured);
  if (!measured.length) return { dcPct: null, dcSeries };
  const sum = emptyTokenClasses();
  for (const bucket of measured) addTokenClasses(sum, bucket.classes);
  return { dcPct: dcPctOf(sum), dcSeries };
}

function asNonNeg(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Provider cache hit % (0–100) over receipts.
 * Per receipt: OpenAI subset uses prompt; Anthropic residual uses cached+prompt+write.
 * Omit when unmeasured. Not run-cache cache_hits/cache_lookups.
 */
export function cacheHitPctFromReceipts(receipts: unknown[]): number | null {
  let cached = 0;
  let input = 0;
  let sawCache = false;
  let sawPrompt = false;
  for (const raw of receipts) {
    const row = asRecord(raw);
    if (!row) continue;
    if (typeof row.tool_id === "string" && DEMO_IDS.has(row.tool_id)) continue;
    const p = asNonNeg(row.prompt_tokens);
    if (p == null) continue;
    sawPrompt = true;
    const classes = asTokenClasses(row.tokenClasses) ?? asTokenClasses(row.classes);
    const fromField = row.cached_tokens != null ? asNonNeg(row.cached_tokens) : null;
    const fromClasses = classes?.providerCache != null ? asNonNeg(classes.providerCache) : null;
    const c = fromField ?? fromClasses;
    if (c != null) {
      const stamped = asNonNeg(row.cache_input_tokens) ?? asNonNeg(row.cacheDenom);
      const anthropicKeys = "cache_read_input_tokens" in row || "cache_creation_input_tokens" in row;
      const writeField = row.cache_creation_input_tokens ?? row.cache_write_tokens ?? row.cacheWrite;
      const write = writeField != null ? asNonNeg(writeField) : anthropicKeys ? 0 : null;
      const denom =
        stamped ??
        (anthropicKeys
          ? (asNonNeg(row.cache_read_input_tokens) ?? c) +
            (asNonNeg(row.cache_creation_input_tokens) ?? 0) +
            (asNonNeg(row.input_tokens) ?? p)
          : providerCacheHitInput(c, p, write));
      if (denom == null) continue;
      sawCache = true;
      cached += c;
      input += denom;
    }
  }
  if (!sawPrompt || !sawCache) return null;
  return cacheHitPctOf(cached, input);
}

function asWorkflow(value: unknown): {
  id: string;
  name: string;
  state: string;
  rollout?: "canary" | "live";
  runs: number;
  fails: number;
} | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || !row.id) return null;
  const state = row.state === "paused" || row.state === "live" ? row.state : null;
  if (!state) return null;
  const stats = asRecord(row.stats);
  const rollout = row.rollout === "canary" || row.rollout === "live" ? row.rollout : undefined;
  return {
    id: row.id,
    name: typeof row.name === "string" && row.name ? row.name : "Workflow",
    state,
    ...(rollout ? { rollout } : {}),
    runs: asCount(stats?.n),
    fails: asCount(stats?.fail),
  };
}

function requestStatus(verdict: string, refused = false): string {
  if (refused && verdict !== "PASS") return "Refused";
  if (verdict === "PASS") return "Ready";
  if (verdict === "FAIL") return "Failed";
  if (verdict === "INCONCLUSIVE") return "Inconclusive";
  return "Pending";
}

function failureModeLabel(mode: string): string {
  if (mode === "loop") return "Loop";
  if (mode === "fail_streak") return "Fail streak";
  if (mode === "low_gain") return "Low gain";
  if (mode === "evidence") return "Evidence";
  if (mode === "refresh") return "Replacement waiting";
  if (mode === "handoff") return "Handoff";
  if (mode === "compose") return "Compose";
  return mode;
}

function asTime(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function asRequest(value: unknown): {
  id: string;
  name: string;
  status: string;
  refused: boolean;
  verdict: string;
  at: number;
  wastedTokens?: number;
} | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || !row.id) return null;
  const program = asRecord(row.program);
  const fromProgram = program && typeof program.name === "string" ? program.name : "";
  const sequence = Array.isArray(row.sequence)
    ? row.sequence.filter((step): step is string => typeof step === "string" && step.length > 0)
    : [];
  const name =
    fromProgram ||
    (sequence.length <= 2 ? sequence.join("_") : sequence.length ? `${sequence[0]}_to_${sequence[sequence.length - 1]}` : "Request");
  const refusal = asRecord(row.refusal);
  const origin = program ? asRecord(program.origin) : asRecord(row.origin);
  const failureMode =
    /replacement is waiting/i.test(typeof program?.description === "string" ? program.description : "")
      ? "refresh"
      : typeof origin?.mode === "string" && origin.mode !== "happy"
        ? origin.mode
        : undefined;
  const verdict = typeof row.verdict === "string" && row.verdict ? row.verdict : "pending";
  const refused = Boolean(refusal);
  const fail = failureMode ? failureModeLabel(failureMode) : "";
  const warnAt = Number(origin?.firstWarningAt);
  const from = Number.isFinite(warnAt) ? ` · from call ${Math.round(warnAt)}` : "";
  const refusedStatus =
    refused && !fail
      ? refusalStatus({
          code: typeof refusal?.code === "string" ? (refusal.code as RefusalCode) : undefined,
          reason: typeof refusal?.reason === "string" ? refusal.reason : "",
          readSet: Number.isFinite(Number(refusal?.readSet)) ? Math.round(Number(refusal?.readSet)) : undefined,
          repeats: Number.isFinite(Number(refusal?.repeats)) ? Math.round(Number(refusal?.repeats)) : undefined,
        })
      : null;
  const status = fail ? `${fail}${from}` : refusedStatus ?? requestStatus(verdict, refused);
  const waste = Number(refusal?.wastedTokens ?? program?.wastedTokens ?? row.wastedTokens);
  return {
    id: row.id,
    name,
    status,
    refused,
    verdict,
    at: asTime(row.created_at),
    ...(Number.isFinite(waste) ? { wastedTokens: Math.round(waste) } : {}),
  };
}

/**
 * Same tile numbers Home uses: compiled, runs, waiting, fails, tokensSaved, dcPct.
 * Unit-testable without a network.
 */
export function digestFromInbox(inbox: InboxSlice | null | undefined, receipts: unknown[] = [], now = Date.now()): DigestInput {
  if (!inbox) return { ...EMPTY_DIGEST };
  const workflows = (inbox.live ?? []).flatMap((row) => {
    const item = asWorkflow(row);
    return item && !DEMO_IDS.has(item.id) ? [item] : [];
  });
  const requests = (inbox.candidates ?? []).flatMap((row) => {
    const item = asRequest(row);
    return item && !DEMO_IDS.has(item.id) ? [item] : [];
  });
  const live = workflows.filter((item) => item.state === "live");
  const compiled = live.length;
  const canary = live.filter((item) => item.rollout === "canary").length;
  const runs = live.reduce((sum, item) => sum + item.runs, 0);
  const receiptFails = live.reduce((sum, item) => sum + item.fails, 0);
  const waiting = requests.filter((item) => !item.refused && item.verdict !== "FAIL").length;
  const requestFails = requests.filter((item) => item.refused || item.verdict === "FAIL").length;
  const dc = dcFromReceipts(receipts, now);
  const cacheHitPct = cacheHitPctFromReceipts(receipts);
  const novelty: DigestNovelty[] = rankByWaste(requests).map((item) => ({ name: item.name, status: item.status }));
  const wordsByTool = stretchWordsByTool(receipts);
  const stretches: DigestStretch[] = workflows.flatMap((item) => {
    const words = wordsByTool.get(item.id);
    return words?.length
      ? [{ name: item.name, state: item.state, ...(item.rollout ? { rollout: item.rollout } : {}), words }]
      : [];
  });
  const emptyTiles =
    compiled === 0 &&
    runs === 0 &&
    waiting === 0 &&
    receiptFails + requestFails === 0 &&
    Math.max(0, Math.round(inbox.savings?.tokensSavedMean ?? 0)) === 0 &&
    dc.dcPct == null &&
    cacheHitPct == null &&
    novelty.length === 0 &&
    stretches.length === 0;
  if (emptyTiles) return { ...EMPTY_DIGEST };
  return {
    optIn: true,
    compiled,
    runs,
    waiting,
    fails: requestFails + receiptFails,
    tokensSaved: Math.max(0, Math.round(inbox.savings?.tokensSavedMean ?? 0)),
    dcPct: dc.dcPct,
    cacheHitPct,
    dcSeries: dc.dcSeries,
    novelty,
    stretches,
    ...(canary ? { canary } : {}),
  };
}

async function readJson(res: Response): Promise<unknown> {
  return await res.json();
}

export async function loadDigestInput(
  args: string[] = [],
  cfg: Config | null = readConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<DigestInput> {
  const urlFlag = arg(args, "--url");
  const base = wrapPlaneUrl(urlFlag || cfg?.base_url);
  const key = (() => {
    try {
      return resolveApiKey(args);
    } catch {
      return cfg?.api_key;
    }
  })();
  if (!key) return { ...EMPTY_DIGEST };
  try {
    const headers = { authorization: `Bearer ${key}` };
    const [inboxRes, receiptRes] = await Promise.all([
      fetchFn(`${base}/v1/inbox`, { headers, signal: AbortSignal.timeout(8_000) }),
      fetchFn(`${base}/v1/receipts`, { headers, signal: AbortSignal.timeout(8_000) }),
    ]);
    if (!inboxRes.ok) return { ...EMPTY_DIGEST };
    const inbox = (await readJson(inboxRes)) as InboxSlice;
    if (!inbox || typeof inbox !== "object") return { ...EMPTY_DIGEST };
    let receipts: unknown[] = [];
    if (receiptRes.ok) {
      try {
        const body = (await readJson(receiptRes)) as { receipts?: unknown };
        receipts = Array.isArray(body.receipts) ? body.receipts : [];
      } catch {
        receipts = [];
      }
    }
    return digestFromInbox(inbox, receipts);
  } catch {
    return { ...EMPTY_DIGEST };
  }
}

export async function digestCli(
  args: string[] = [],
  opts?: { fetch?: typeof fetch },
): Promise<number> {
  try {
    if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
      console.log(digestHelp());
      return 0;
    }
    const cfg = readConfig();
    if (!digestOptedIn(cfg)) {
      console.log("digest is off");
      return 0;
    }
    const input = await loadDigestInput(args, cfg, opts?.fetch ?? fetch);
    const html = args.includes("--html");
    const body = html ? renderDigestHtml(input) : renderDigestText(input);
    if (body == null) {
      console.log("digest is off");
      return 0;
    }
    const out = arg(args, "--out");
    if (out) {
      writeFileSync(out, body.endsWith("\n") ? body : `${body}\n`);
      console.error(`wrote ${out}`);
    } else {
      process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
    }
    return 0;
  } catch {
    if (digestOptedIn()) {
      const body = renderDigestText(EMPTY_DIGEST);
      if (body) process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
      return 0;
    }
    console.log("digest is off");
    return 0;
  }
}
