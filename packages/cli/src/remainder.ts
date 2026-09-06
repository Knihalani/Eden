import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  ARM_SLACK_CALLS,
  ARM_TTL_MS,
  armExpired,
  armMaxPerSession,
  hintIdOf,
  mightClaim,
  restCounts,
  totalRest,
  type Armed,
} from "@eden/wrap";
import { eq } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";
import { edenHome, ensureHome, safeRunId, withFileLock, writeFileAtomic, appendJsonl, readConfig, wrapPlaneUrl } from "./home";

export type RemainderLocker = <T>(lockPath: string, fn: () => T) => T | Promise<T>;

export type RemainderEntry = {
  name?: string;
  id?: string;
  sequence?: string[];
  envelope?: { inputs?: Record<string, unknown[]> } | null;
};

type Persisted = {
  rest: Record<string, number>;
  input: Record<string, unknown>;
  programId: string;
  programName: string;
  armedAt: number;
  budgetCalls: number;
  matchedCalls: number;
  hintId: unknown;
  closed: boolean;
};

type Bucket = { recency: string[]; byKey: Record<string, Persisted> };
type FileShape = { seq: number; sessions: Record<string, Bucket> };

const SETTLED = Promise.resolve(true);

export function remainderPath(): string {
  return join(edenHome(), "remainder.json");
}

export function ledgerPath(): string {
  return join(edenHome(), "ledger.jsonl");
}

export function remainderDenyReason(program: string, tool: string): string {
  return `Already served by ${program}. Do not re-run ${tool} — facts are in the last tool output or attached as context.`;
}

/** Observed only when a host (or replica) actually drops `updatedToolOutput`.
 * Live Claude Code never acks always-drop of a *correct* native rewrite.
 * `applyHookOutput.droppedRewrite` is shape-mismatch only; the silent-drop
 * replica writes this class when it forces the drop. */
export function hostDropReason(): string {
  return "The host dropped the rewrite (updatedToolOutput). Original tool output was kept.";
}

export function appendLedgerRow(row: {
  session: string;
  class: "transparent" | "steered-skip" | "host-drop";
  program?: string;
  programId?: string;
  tool?: string;
}): void {
  ensureHome();
  appendJsonl(ledgerPath(), {
    run_id: row.session,
    kind: row.class,
    class: row.class,
    program: row.program,
    programId: row.programId,
    tool: row.tool,
    ts: Date.now(),
  });
  postLedgerReceipt(row);
}

function postLedgerReceipt(row: {
  class: "transparent" | "steered-skip" | "host-drop";
  program?: string;
  programId?: string;
  tool?: string;
}): void {
  try {
    const cfg = readConfig();
    if (!cfg?.base_url || !cfg.api_key) return;
    const reason =
      row.class === "steered-skip" && row.program && row.tool
        ? remainderDenyReason(row.program, row.tool)
        : row.class === "host-drop"
          ? hostDropReason()
          : undefined;
    void fetch(`${wrapPlaneUrl(cfg.base_url)}/v1/receipts`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.api_key}`, "content-type": "application/json" },
      body: JSON.stringify({
        toolId: row.programId || row.program || "hook",
        version: "",
        ms: 0,
        llmCalls: 0,
        cents: 0,
        ok: true,
        outcome: row.class === "steered-skip" ? "skipped" : row.class === "host-drop" ? "degraded" : "ok",
        ...(row.class === "steered-skip"
          ? { tokenClass: "steered-skip", skipped: row.tool ? [row.tool] : [] }
          : row.class === "transparent"
            ? { tokenClass: "transparent" }
            : {}),
        reason,
      }),
    }).catch(() => undefined);
  } catch {
    /* fail-open: ledger already landed */
  }
}

function emptyFile(): FileShape {
  return { seq: 0, sessions: Object.create(null) as FileShape["sessions"] };
}

function readFile(): FileShape {
  const path = remainderPath();
  if (!existsSync(path)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as FileShape;
    if (!parsed || typeof parsed !== "object") return emptyFile();
    return {
      seq: typeof parsed.seq === "number" ? parsed.seq : 0,
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : emptyFile().sessions,
    };
  } catch {
    return emptyFile();
  }
}

function writeFile(data: FileShape): void {
  writeFileAtomic(remainderPath(), JSON.stringify(data));
}

function sessionKey(session: string): string {
  const id = safeRunId(session || "local");
  if (id === "__proto__" || id === "constructor" || id === "prototype") return `sess_${id}`;
  return id;
}

function restToRecord(rest: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const [k, v] of rest) out[k] = v;
  return out;
}

function restToMap(rest: Record<string, number> | undefined): Map<string, number> {
  const m = new Map<string, number>();
  if (!rest || typeof rest !== "object") return m;
  for (const k of Object.keys(rest)) {
    const n = rest[k];
    if (typeof n === "number" && n > 0) m.set(k, n);
  }
  return m;
}

function asArmed(row: Persisted): Armed {
  return {
    rest: restToMap(row.rest),
    input: row.input,
    programId: row.programId,
    armedAt: row.armedAt,
    armedAtCall: 0,
    budgetCalls: row.budgetCalls,
    matchedCalls: row.matchedCalls,
    settled: SETTLED,
    resolveSettled: () => undefined,
    closed: row.closed,
    hintId: row.hintId,
  };
}

/**
 * Join a hook `file_path`/`path` against the Claude `cwd`.
 *
 * `path.resolve(cwd, relative)` is the identity: `./a.ts` under
 * `/Users/me/repo` is `/Users/me/repo/a.ts`. An already-absolute path ignores
 * cwd (Node right-to-left). Without cwd, relatives stay as written — we never
 * invent `process.cwd()` (hookd's cwd is not the agent's project).
 */
export function joinAgainstCwd(filePath: string, cwd?: string): string {
  if (!filePath) return filePath;
  if (typeof cwd === "string" && cwd.length > 0) return resolve(cwd, filePath);
  return isAbsolute(filePath) ? resolve(filePath) : filePath;
}

/** Wrap `hintIdOf` for tickets; remainder-local hint is the resolved path when wrap has none. */
export function remainderHintOf(rec: Record<string, unknown>): unknown {
  const ticket = hintIdOf(rec);
  if (ticket !== undefined) return ticket;
  return pathish(rec);
}

function resolveIdentity(rec: Record<string, unknown>, cwd?: string): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(rec)) out[k] = rec[k];
  const p = pathish(rec);
  if (!p) return out;
  const joined = joinAgainstCwd(p, cwd);
  out.file_path = joined;
  out.path = joined;
  return out;
}

export function extractRemainderInput(
  entry: RemainderEntry | null,
  args: Record<string, unknown>,
  cwd?: string,
): Record<string, unknown> {
  const envKeys = Object.keys(entry?.envelope?.inputs ?? {});
  const out: Record<string, unknown> = Object.create(null);
  for (const k of envKeys) {
    if (k in args) out[k] = args[k];
  }
  let picked: Record<string, unknown>;
  if (Object.keys(out).length) {
    picked = out;
  } else {
    const aliases = ["id", "ticket_id", "ticketId", "issue", "number", "key", "file_path", "path"] as const;
    picked = out;
    let found = false;
    for (const a of aliases) {
      if (a in args) {
        out[a] = args[a];
        const p = pathish(args);
        if (p) {
          out.file_path = p;
          out.path = p;
        }
        found = true;
        break;
      }
    }
    if (!found) {
      const p = pathish(args);
      picked = p ? { file_path: p, path: p } : args;
    }
  }
  return resolveIdentity(picked, cwd);
}

function pathish(rec: Record<string, unknown>): string | undefined {
  for (const k of ["file_path", "path"]) {
    const v = rec[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function inputMatches(armedInput: Record<string, unknown>, cur: Record<string, unknown>, cwd?: string): boolean {
  if (eq(cur, armedInput)) return true;
  const ap = pathish(armedInput);
  const cp = pathish(cur);
  if (ap && cp) {
    if (joinAgainstCwd(ap, cwd) !== joinAgainstCwd(cp, cwd)) return false;
    const idKeys = ["id", "ticket_id", "ticketId", "issue", "number", "key"] as const;
    for (const k of idKeys) {
      if (k in armedInput && k in cur && !eq(armedInput[k], cur[k])) return false;
    }
    return true;
  }
  const keys = Object.keys(cur);
  return keys.length > 0 && keys.every((k) => k in armedInput && eq(cur[k], armedInput[k]));
}

/** Pull the armed entity keys out of a later call that may carry extra tool args. */
function extractAgainst(armedInput: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(armedInput)) {
    if (k in args) out[k] = args[k];
  }
  return out;
}

function sweepBucket(b: Bucket, now: number): void {
  for (const key of Object.keys(b.byKey)) {
    const row = b.byKey[key];
    if (!row) continue;
    if (armExpired(asArmed(row), now)) {
      delete b.byKey[key];
      const i = b.recency.indexOf(key);
      if (i >= 0) b.recency.splice(i, 1);
    }
  }
}

async function withStore<T>(locker: RemainderLocker, fn: (data: FileShape) => T): Promise<T> {
  ensureHome();
  const lock = `${remainderPath()}.lock`;
  return await Promise.resolve(
    locker(lock, () => {
      const data = readFile();
      const out = fn(data);
      writeFile(data);
      return out;
    }),
  );
}

/**
 * Arm the tail after a successful transparent serve. Fail-open at cap (no live
 * eviction). Returns false when the session/global gate refuses the insert.
 */
export async function armRemainder(
  session: string,
  entry: RemainderEntry,
  input: Record<string, unknown>,
  locker: RemainderLocker = withFileLock,
  cwd?: string,
): Promise<boolean> {
  try {
    const seq = entry.sequence ?? [];
    if (seq.length < 2) return false;
    const program = { sequence: seq } as StretchProgram;
    const rest = restCounts(program);
    if (!totalRest(rest)) return false;
    const extracted = extractRemainderInput(entry, input, cwd);
    const sid = sessionKey(session);
    return await withStore(locker, (data) => {
      const now = Date.now();
      let bucket = data.sessions[sid];
      if (!bucket) {
        bucket = { recency: [], byKey: Object.create(null) as Record<string, Persisted> };
        data.sessions[sid] = bucket;
      }
      sweepBucket(bucket, now);
      const cap = armMaxPerSession();
      if (Object.keys(bucket.byKey).length >= cap) return false;
      data.seq += 1;
      const key = `${entry.id || entry.name || "p"}#${data.seq}`;
      bucket.byKey[key] = {
        rest: restToRecord(rest),
        input: extracted,
        programId: String(entry.id || entry.name || key),
        programName: String(entry.name || "program"),
        armedAt: now,
        budgetCalls: totalRest(rest) + ARM_SLACK_CALLS,
        matchedCalls: 0,
        hintId: remainderHintOf(extracted),
        closed: true,
      };
      bucket.recency.push(key);
      return true;
    });
  } catch {
    return false;
  }
}

export type RemainderClaim = { program: string; programId: string; tool: string; key: string };

/**
 * Claim one rest unit for this call. Newest-first. Matching calls burn budget
 * even when the name is not in rest. Throws never — fail-open returns null.
 */
export async function claimRemainder(
  session: string,
  toolName: string,
  input: Record<string, unknown>,
  locker: RemainderLocker = withFileLock,
  entry?: RemainderEntry | null,
  cwd?: string,
): Promise<RemainderClaim | null> {
  try {
    const sid = sessionKey(session);
    const resolved = resolveIdentity(input, cwd);
    const fallback = extractRemainderInput(entry ?? null, resolved, cwd);
    return await withStore(locker, (data) => {
      const bucket = data.sessions[sid];
      if (!bucket) return null;
      const now = Date.now();
      sweepBucket(bucket, now);
      for (let i = bucket.recency.length - 1; i >= 0; i--) {
        const key = bucket.recency[i]!;
        const row = bucket.byKey[key];
        if (!row) continue;
        const armed = asArmed(row);
        if (armExpired(armed, now)) {
          delete bucket.byKey[key];
          bucket.recency.splice(i, 1);
          continue;
        }
        const against = extractAgainst(row.input, resolved);
        const cur = Object.keys(against).length ? against : fallback;
        if (!mightClaim(armed, toolName, cur) && !mightClaim(armed, toolName, resolved)) continue;
        if (!inputMatches(row.input, cur, cwd)) continue;
        // Burn budget whether or not a rest unit remains (wrap skipRest).
        row.matchedCalls += 1;
        const left = restToMap(row.rest).get(toolName) ?? 0;
        if (!left) continue;
        const next = left - 1;
        if (next > 0) row.rest[toolName] = next;
        else delete row.rest[toolName];
        if (!Object.keys(row.rest).length) {
          delete bucket.byKey[key];
          bucket.recency.splice(i, 1);
        }
        return { program: row.programName, programId: row.programId, tool: toolName, key };
      }
      return null;
    });
  } catch {
    return null;
  }
}

export type BatchCall = {
  tool_name: string;
  tool_input: Record<string, unknown>;
};

/**
 * Claude Code `PostToolBatch` payload: `tool_calls[]` with name/input/response.
 * Missing or non-array → null (caller fail-opens to `{}`). Items without a
 * name are skipped; an empty parsed list is still a valid batch (no-op arm).
 */
export function parseToolCalls(raw: unknown): BatchCall[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BatchCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const name = rec.tool_name ?? rec.toolName ?? rec.name;
    if (typeof name !== "string" || !name) continue;
    const input = rec.tool_input ?? rec.args ?? rec.parameters;
    out.push({
      tool_name: name,
      tool_input: input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
    });
  }
  return out;
}

function mergeBatchIdentity(calls: BatchCall[], head?: string, cwd?: string): Record<string, unknown> {
  const headCall = head ? calls.find((c) => c.tool_name === head) : undefined;
  const ordered = headCall ? [headCall, ...calls.filter((c) => c !== headCall)] : calls;
  const out: Record<string, unknown> = Object.create(null);
  for (const c of ordered) {
    const rec = c.tool_input;
    for (const k of ["id", "ticket_id", "ticketId", "issue", "number", "key", "file_path", "path"] as const) {
      if (k in rec && out[k] === undefined) out[k] = rec[k];
    }
  }
  const p = pathish(out) ?? ordered.map((c) => pathish(c.tool_input)).find(Boolean);
  if (p) {
    out.file_path = p;
    out.path = p;
  }
  const picked = Object.keys(out).length ? out : (ordered[0]?.tool_input ?? {});
  return resolveIdentity(picked, cwd);
}

/**
 * After a parallel batch resolves, arm remainder from the full `tool_calls`
 * set so sibling tails do not double-execute on the next PreToolUse.
 *
 * Arms a live program when rest names appear in the batch AND (the head is
 * in this batch OR it was already served this session). Returns the program
 * names that were armed. Fail-open: throws never, empty list on error.
 */
export async function armRemainderFromBatch(
  session: string,
  calls: BatchCall[],
  live: RemainderEntry[],
  locker: RemainderLocker = withFileLock,
  opts?: { servedHeads?: Iterable<string>; cwd?: string },
): Promise<string[]> {
  const armed: string[] = [];
  try {
    if (!calls.length || !live.length) return armed;
    const names = new Set(calls.map((c) => c.tool_name).filter(Boolean));
    const served = new Set(opts?.servedHeads ? [...opts.servedHeads] : []);
    const cwd = opts?.cwd;
    for (const entry of live) {
      const seq = entry.sequence ?? [];
      if (seq.length < 2) continue;
      const head = seq[0]!;
      const rest = seq.slice(1);
      if (!rest.some((n) => names.has(n))) continue;
      const headInBatch = names.has(head);
      if (!headInBatch && !served.has(head)) continue;
      const input = mergeBatchIdentity(calls, head, cwd);
      const ok = await armRemainder(session, entry, input, locker, cwd);
      if (ok) armed.push(String(entry.name || entry.id || "program"));
    }
  } catch {
    return armed;
  }
  return armed;
}

export { ARM_SLACK_CALLS, ARM_TTL_MS };
