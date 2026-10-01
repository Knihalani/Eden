import { isCheckName } from "@eden/ir/names";
import { emptyTokenClasses, refusalStatus, rolloutPartition, zeroLlm, type RefusalCode } from "@eden/ir";
import {
  addTokenClasses,
  asTokenClasses,
  dcPct as dcPctOf,
  aggregateFleetDc,
  rankByWaste,
  stretchHead,
  stretchLine,
  stretchWords,
  stretchWordsByTool,
  toolIdOf,
  type StretchWord,
} from "@eden/measure";
import { cacheRunWord } from "../canvas/cache-reads";

export type { StretchWord };

/** Same short words as canvas `failLabel` — remainder skip / host-drop only. */
export type LastReceiptKind = "Skipped" | "Degraded";

export type FleetAgent = {
  id: string;
  parentRunId?: string;
  dcPct: number | null;
};

export type FleetStrip = {
  agents: FleetAgent[];
  fleetDcPct: number | null;
  sharedLine: string | null;
  region?: string | null;
};

export type WorkflowItem = {
  id: string;
  name: string;
  state: string;
  at: number;
  runs: number;
  fails: number;
  llmTimes: number;
  /** Whole stretch for this tool. Order is always Served, then Skipped, then Degraded. */
  stretchWords?: StretchWord[];
  /** Last skip/drop word of the stretch. Prefer `stretchWords`. */
  lastKind?: LastReceiptKind;
  /** Words only, when the latest receipt consulted the cache. Never digits. */
  cacheNote?: string;
  /** Exact ledger line when sharedAcross ≥ 2. */
  sharedNote?: string;
  /** Serving stamp. Absent on already-live tools with no flag. */
  rollout?: "canary" | "live";
  /** True when every island is absent or pinned. */
  zeroLlm?: boolean;
};

export type RequestItem = {
  id: string;
  name: string;
  verdict: string;
  refused: boolean;
  at: number;
  failureMode?: string;
  firstWarningAt?: number;
  refusalCode?: RefusalCode;
  readSet?: number;
  repeats?: number;
  refusalReason?: string;
  /** Provider prompt+completion on the refused or waiting-PASS cluster. Absent/0 = unmeasured. */
  wastedTokens?: number;
};

export type DayPoint = {
  label: string;
  runs: number;
};

export type DcPoint = {
  label: string;
  dcPct: number;
  measured: boolean;
};

export type Activity = {
  runs: number;
  compiled: number;
  waiting: number;
  fails: number;
  llmTimes: number;
  tokensSaved: number;
  /** Null when no receipt in the window carried tokenClasses. Never a fake share. */
  dcPct: number | null;
  failed: boolean;
  series: DayPoint[];
  dcSeries: DcPoint[];
  workflows: WorkflowItem[];
  requests: RequestItem[];
  /** Overview fleet/org strip. Empty inbox is agents [], fleetDcPct null, sharedLine null. */
  fleet?: FleetStrip;
};

export const EMPTY_SERIES: DayPoint[] = emptySeries();
export const EMPTY_DC_SERIES: DcPoint[] = emptyDcSeries();
export const EMPTY_FLEET: FleetStrip = { agents: [], fleetDcPct: null, sharedLine: null };

export const EMPTY_ACTIVITY: Activity = {
  runs: 0,
  compiled: 0,
  waiting: 0,
  fails: 0,
  llmTimes: 0,
  tokensSaved: 0,
  dcPct: null,
  failed: false,
  series: EMPTY_SERIES,
  dcSeries: EMPTY_DC_SERIES,
  workflows: [],
  requests: [],
  fleet: EMPTY_FLEET,
};

export type InboxSlice = {
  candidates?: unknown[];
  live?: unknown[];
  savings?: {
    runs?: number;
    live?: number;
    llmReductionMean?: number;
    tokensSavedMean?: number;
    timeSavedMsMean?: number;
  };
};

const DEMO_IDS = new Set(["cand_resolve", "cand_pending", "cand_refused", "live_notify", "live_paused"]);

export function activityFromInbox(
  inbox: InboxSlice | null | undefined,
  receipts: unknown[] = [],
  now = Date.now(),
): Activity {
  if (!inbox) return emptyActivity();
  const byTool = stretchByTool(receipts);
  const lastCache = lastCacheFromReceipts(receipts);
  const lastShared = lastSharedFromReceipts(receipts);
  const workflows = (inbox.live ?? [])
    .flatMap((row) => {
      const item = asWorkflow(row);
      return item && !DEMO_IDS.has(item.id) ? [item] : [];
    })
    .map((item) => {
      const words = byTool.get(item.id);
      const lastKind = words ? lastKindOf(words) : undefined;
      const cacheNote = lastCache.get(item.id);
      const sharedNote = lastShared.get(item.id);
      if (!words?.length && !cacheNote && !sharedNote) return item;
      return {
        ...item,
        ...(words?.length ? { stretchWords: words } : {}),
        ...(lastKind ? { lastKind } : {}),
        ...(cacheNote ? { cacheNote } : {}),
        ...(sharedNote ? { sharedNote } : {}),
      };
    })
    .sort(byRecency);
  const requests = (inbox.candidates ?? [])
    .flatMap((row) => {
      const item = asRequest(row);
      return item && !DEMO_IDS.has(item.id) ? [item] : [];
    })
    .sort(byRecency);
  const live = workflows.filter((item) => item.state === "live");
  const compiled = live.length;
  const runs = live.reduce((sum, item) => sum + item.runs, 0);
  const receiptFails = live.reduce((sum, item) => sum + item.fails, 0);
  const waiting = requests.filter((item) => !item.refused && item.verdict !== "FAIL").length;
  const requestFails = requests.filter((item) => item.refused || item.verdict === "FAIL").length;
  const dc = dcFromReceipts(receipts, now);
  return {
    runs,
    compiled,
    waiting,
    fails: requestFails + receiptFails,
    llmTimes: 0,
    tokensSaved: Math.max(0, Math.round(inbox.savings?.tokensSavedMean ?? 0)),
    dcPct: dc.dcPct,
    failed: false,
    series: receiptSeries(receipts, now),
    dcSeries: dc.dcSeries,
    workflows,
    requests,
    fleet: fleetFromReceipts(receipts),
  };
}

export function emptyActivity(): Activity {
  return {
    ...EMPTY_ACTIVITY,
    workflows: [],
    requests: [],
    series: emptySeries(),
    dcSeries: emptyDcSeries(),
    dcPct: null,
    fleet: { agents: [], fleetDcPct: null, sharedLine: null },
  };
}

export function failedActivity(): Activity {
  return { ...emptyActivity(), failed: true };
}

export function formatCount(n: number) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(n)));
}

/** Honest tile: unmeasured is an em dash, never a fake 40%. */
export function formatDcPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}

export function receiptSeries(receipts: unknown[], now = Date.now()): DayPoint[] {
  const days = 7;
  const start = startOfLocalDay(now);
  start.setDate(start.getDate() - (days - 1));
  const buckets = Array.from({ length: days }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return {
      key: dayKey(day),
      label: day.toLocaleDateString("en-US", { weekday: "short" }),
      runs: 0,
    };
  });
  const index = new Map(buckets.map((bucket, i) => [bucket.key, i]));
  for (const raw of receipts) {
    const row = asRecord(raw);
    if (!row) continue;
    if (typeof row.tool_id === "string" && DEMO_IDS.has(row.tool_id)) continue;
    const t = Number(row.created_at);
    if (!Number.isFinite(t) || t <= 0) continue;
    const i = index.get(dayKey(new Date(t)));
    if (i == null) continue;
    buckets[i]!.runs += 1;
  }
  return buckets.map(({ label, runs }) => ({ label, runs }));
}

export function dcFromReceipts(receipts: unknown[], now = Date.now()): { dcPct: number | null; dcSeries: DcPoint[] } {
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
  const dcSeries: DcPoint[] = buckets.map((bucket) => ({
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

export function livePath(id: string) {
  return `/live/${encodeURIComponent(id)}`;
}

export function requestPath(id: string) {
  return `/request/${encodeURIComponent(id)}`;
}

export function requestStatus(verdict: string, refused = false) {
  if (refused && verdict !== "PASS") return "Refused";
  if (verdict === "PASS") return "Ready";
  if (verdict === "FAIL") return "Failed";
  if (verdict === "INCONCLUSIVE") return "Inconclusive";
  return "Pending";
}

export function workflowServing(workflows: Array<{ state?: string; rollout?: string | null }>) {
  return rolloutPartition(workflows.filter((w) => w.state === "live").map((w) => ({ rollout: w.rollout })));
}

export function workflowStatus(
  state: string,
  words: StretchWord[] | LastReceiptKind | null | undefined = [],
  cacheNote?: string | null,
  sharedNote?: string | null,
  rollout?: "canary" | "live" | null,
  isZeroLlm?: boolean | null,
) {
  const list: StretchWord[] = typeof words === "string" ? [words] : (words ?? []);
  return stretchLine(stretchHead(state, rollout), list, [cacheNote, sharedNote, isZeroLlm ? "Zero-LLM" : null]);
}

/** Home row pip. Canary is serving (ink), not waiting for Approve (muted). */
export function statusTone(status: string) {
  if (
    status.startsWith("Failed") ||
    status.startsWith("Refused") ||
    status.startsWith("Read-set") ||
    status.startsWith("Unbound") ||
    status.startsWith("Too short") ||
    status.startsWith("Unique work") ||
    status.startsWith("Width split") ||
    status.startsWith("Envelope gap") ||
    status.startsWith("Empty output") ||
    status.startsWith("No envelope") ||
    status.startsWith("Invalid") ||
    status.startsWith("At cap") ||
    status.includes("Fail streak") ||
    status.startsWith("Loop") ||
    status.startsWith("Low gain") ||
    status.startsWith("Evidence")
  ) {
    return "fail";
  }
  if (status.startsWith("Ready")) return "ready";
  if (status === "Live" || status.startsWith("Live ·")) return "live";
  if (status === "Canary" || status.startsWith("Canary ·")) return "live";
  return "wait";
}

/**
 * Single-row skip/drop word. Home status uses the whole stretch instead.
 * A successful remainder (ok + skipped tails) is Skipped, never Failed.
 */
export function lastReceiptKind(receipt: unknown): LastReceiptKind | null {
  return lastKindOf(stretchWords([receipt])) ?? null;
}

export type InboxKind = "request" | "workflow";

export type InboxItem = {
  id: string;
  name: string;
  href: string;
  kind: InboxKind;
  kindLabel: string;
  status: string;
};

export function failureModeLabel(mode: string) {
  if (mode === "loop") return "Loop";
  if (mode === "fail_streak") return "Fail streak";
  if (mode === "low_gain") return "Low gain";
  if (mode === "evidence") return "Evidence";
  if (mode === "refresh") return "Replacement waiting";
  if (mode === "handoff") return "Handoff";
  if (mode === "compose") return "Compose";
  return mode;
}

export function inboxItems(activity: Activity): InboxItem[] {
  const requests = Array.isArray(activity.requests) ? activity.requests : [];
  const workflows = Array.isArray(activity.workflows) ? activity.workflows : [];
  const requestItems = rankByWaste(
    requests.map((item) => ({
      id: `request:${item.id}`,
      name: item.name,
      href: requestPath(item.id),
      kind: "request" as const,
      kindLabel: "Request",
      status: requestInboxStatus(item),
      at: item.at,
      wastedTokens: item.wastedTokens,
    })),
  ).map(({ at: _at, wastedTokens: _waste, ...item }) => item);
  return [
    ...requestItems,
    ...workflows.map((item) => ({
      id: `workflow:${item.id}`,
      name: item.name,
      href: livePath(item.id),
      kind: "workflow" as const,
      kindLabel: "Workflow",
      status: workflowStatus(
        item.state,
        item.stretchWords ?? (item.lastKind ? [item.lastKind] : []),
        item.cacheNote,
        item.sharedNote,
        item.rollout,
        item.zeroLlm,
      ),
    })),
  ];
}

function requestInboxStatus(item: RequestItem): string {
  const base = requestStatus(item.verdict, item.refused);
  const fail = item.failureMode ? failureModeLabel(item.failureMode) : "";
  const from = item.firstWarningAt != null ? ` · from call ${item.firstWarningAt}` : "";
  const refusedStatus =
    item.refused && !fail
      ? refusalStatus({
          code: item.refusalCode,
          reason: item.refusalReason ?? "",
          readSet: item.readSet,
          repeats: item.repeats,
        })
      : null;
  return fail ? `${fail}${from}` : (refusedStatus ?? base);
}

function emptySeries(): DayPoint[] {
  return receiptSeries([]);
}

function emptyDcSeries(): DcPoint[] {
  return dcFromReceipts([]).dcSeries;
}

function startOfLocalDay(ms: number) {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day;
}

function dayKey(day: Date) {
  return `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
}

function byRecency(a: { at: number }, b: { at: number }) {
  return b.at - a.at;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTime(...values: unknown[]) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

function asCount(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function lastKindOf(words: StretchWord[]): LastReceiptKind | undefined {
  if (words.includes("Degraded")) return "Degraded";
  if (words.includes("Skipped")) return "Skipped";
  return undefined;
}

/** Whole stretch per tool — not the latest row. Seed demo ids stay out. */
function stretchByTool(receipts: unknown[]): Map<string, StretchWord[]> {
  return stretchWordsByTool(
    receipts.filter((raw) => {
      const id = toolIdOf(raw);
      return Boolean(id) && !DEMO_IDS.has(id);
    }),
  );
}

function lastSharedFromReceipts(receipts: unknown[]): Map<string, string> {
  const latest = new Map<string, { t: number; order: number; note: string | null }>();
  receipts.forEach((raw, order) => {
    const row = asRecord(raw);
    if (!row) return;
    const id = typeof row.tool_id === "string" ? row.tool_id : typeof row.toolId === "string" ? row.toolId : "";
    if (!id || DEMO_IDS.has(id)) return;
    const n = Number(row.created_at);
    const t = Number.isFinite(n) && n > 0 ? n : 0;
    const prev = latest.get(id);
    if (!prev || t > prev.t || (t === prev.t && order < prev.order)) {
      latest.set(id, { t, order, note: sharedNoteOf(row) });
    }
  });
  const out = new Map<string, string>();
  for (const [id, hit] of latest) {
    if (hit.note) out.set(id, hit.note);
  }
  return out;
}

function sharedNoteOf(row: Record<string, unknown>): string | null {
  const n = Number(row.sharedAcross);
  if (Number.isFinite(n) && n >= 2) return `shared across ${n} agents`;
  const reason = typeof row.reason === "string" ? row.reason : "";
  const m = /shared across (\d+) agents/.exec(reason);
  if (m && Number(m[1]) >= 2) return `shared across ${m[1]} agents`;
  return null;
}

export function fleetFromReceipts(receipts: unknown[]): FleetStrip {
  const agents = new Map<
    string,
    { id: string; parentRunId?: string; classes: ReturnType<typeof emptyTokenClasses>; measured: boolean }
  >();
  let maxShared = 0;
  let region: string | undefined;
  const fleetRuns: Array<{
    fleet?: string;
    agent?: string;
    region?: string;
    classes: ReturnType<typeof emptyTokenClasses>;
  }> = [];
  for (const raw of receipts) {
    const row = asRecord(raw);
    if (!row) continue;
    const agentId =
      (typeof row.agentId === "string" && row.agentId) || (typeof row.agent === "string" && row.agent) || "";
    const parentRunId = typeof row.parentRunId === "string" && row.parentRunId ? row.parentRunId : undefined;
    const fleetId = typeof row.fleetId === "string" && row.fleetId ? row.fleetId : undefined;
    const recRegion = typeof row.region === "string" && row.region ? row.region : undefined;
    if (recRegion) region = recRegion;
    const shared = Number(row.sharedAcross);
    if (Number.isFinite(shared) && shared >= 2) maxShared = Math.max(maxShared, shared);
    const classes = asTokenClasses(row.tokenClasses) ?? asTokenClasses(row.classes);
    if (agentId) {
      const prev = agents.get(agentId);
      if (!prev) {
        agents.set(agentId, {
          id: agentId,
          ...(parentRunId ? { parentRunId } : {}),
          classes: classes ? addTokenClasses(emptyTokenClasses(), classes) : emptyTokenClasses(),
          measured: !!classes,
        });
      } else {
        if (parentRunId && !prev.parentRunId) prev.parentRunId = parentRunId;
        if (classes) {
          addTokenClasses(prev.classes, classes);
          prev.measured = true;
        }
      }
    }
    if (classes) {
      fleetRuns.push({
        ...(fleetId ? { fleet: fleetId } : {}),
        ...(agentId ? { agent: agentId } : {}),
        ...(recRegion ? { region: recRegion } : {}),
        classes,
      });
    }
  }
  const anyClasses = fleetRuns.length > 0;
  const fleetRow = aggregateFleetDc(fleetRuns);
  const agentList: FleetAgent[] = [...agents.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((a) => ({
      id: a.id,
      ...(a.parentRunId ? { parentRunId: a.parentRunId } : {}),
      dcPct: a.measured ? dcPctOf(a.classes) : null,
    }));
  return {
    agents: agentList,
    fleetDcPct: anyClasses ? fleetRow.dcPct : null,
    sharedLine: maxShared >= 2 ? `shared across ${maxShared} agents` : null,
    ...(region ? { region } : {}),
  };
}

function lastCacheFromReceipts(receipts: unknown[]): Map<string, string> {
  const latest = new Map<string, { t: number; order: number; note: string | null }>();
  receipts.forEach((raw, order) => {
    const row = asRecord(raw);
    if (!row) return;
    const id = typeof row.tool_id === "string" ? row.tool_id : "";
    if (!id || DEMO_IDS.has(id)) return;
    const n = Number(row.created_at);
    const t = Number.isFinite(n) && n > 0 ? n : 0;
    const prev = latest.get(id);
    if (!prev || t > prev.t || (t === prev.t && order < prev.order)) {
      latest.set(id, { t, order, note: cacheRunWord(asFinite(row.cache_hits), asFinite(row.cache_lookups)) });
    }
  });
  const out = new Map<string, string>();
  for (const [id, hit] of latest) {
    if (hit.note) out.set(id, hit.note);
  }
  return out;
}

function asFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asWorkflow(value: unknown): WorkflowItem | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || !row.id) return null;
  const state = row.state === "paused" || row.state === "live" ? row.state : null;
  if (!state) return null;
  const last = asRecord(row.last);
  const stats = asRecord(row.stats);
  const program = asRecord(row.program);
  const rawSteps = Array.isArray(program?.steps) ? program.steps : null;
  const rollout = row.rollout === "canary" || row.rollout === "live" ? row.rollout : undefined;
  const isZero = rawSteps
    ? zeroLlm({
        steps: rawSteps.map((s) => {
          const step = asRecord(s);
          return { kind: typeof step?.kind === "string" ? step.kind : "", pinned: step?.pinned === true };
        }),
      })
    : undefined;
  return {
    id: row.id,
    name: typeof row.name === "string" && row.name ? row.name : "Workflow",
    state,
    at: asTime(row.updated_at, last?.created_at, row.created_at),
    runs: asCount(stats?.n),
    fails: asCount(stats?.fail),
    llmTimes: 0,
    ...(rollout ? { rollout } : {}),
    ...(isZero ? { zeroLlm: true } : {}),
  };
}

function stretchLabel(sequence: string[]): string {
  const core = sequence.filter((n) => !isCheckName(n));
  const parts = core.length ? core : sequence;
  if (!parts.length) return "Request";
  return parts.length <= 2 ? parts.join("_") : `${parts[0]}_to_${parts[parts.length - 1]}`;
}

function asRequest(value: unknown): RequestItem | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || !row.id) return null;
  const program = asRecord(row.program);
  const fromProgram = program && typeof program.name === "string" ? program.name : "";
  const sequence = Array.isArray(row.sequence)
    ? row.sequence.filter((step): step is string => typeof step === "string" && step.length > 0)
    : [];
  const refusal = asRecord(row.refusal);
  const origin = asRecord(program?.origin) ?? asRecord(row.origin);
  const failureMode = /replacement is waiting/i.test(
    typeof program?.description === "string" ? program.description : "",
  )
    ? "refresh"
    : typeof origin?.mode === "string" && origin.mode !== "happy"
      ? origin.mode
      : undefined;
  const rawWarn = origin?.firstWarningAt;
  const warnAt = Number(rawWarn);
  const code = typeof refusal?.code === "string" ? (refusal.code as RefusalCode) : undefined;
  const readSet = Number(refusal?.readSet);
  const repeats = Number(refusal?.repeats);
  const waste = Number(refusal?.wastedTokens ?? program?.wastedTokens ?? row.wastedTokens);
  return {
    id: row.id,
    name: fromProgram || stretchLabel(sequence),
    verdict: typeof row.verdict === "string" && row.verdict ? row.verdict : "pending",
    refused: Boolean(refusal),
    at: asTime(row.created_at),
    ...(failureMode ? { failureMode } : {}),
    ...(rawWarn != null && rawWarn !== "" && Number.isFinite(warnAt) ? { firstWarningAt: Math.round(warnAt) } : {}),
    ...(code ? { refusalCode: code } : {}),
    ...(Number.isFinite(readSet) ? { readSet: Math.round(readSet) } : {}),
    ...(Number.isFinite(repeats) ? { repeats: Math.round(repeats) } : {}),
    ...(typeof refusal?.reason === "string" && refusal.reason ? { refusalReason: refusal.reason } : {}),
    ...(Number.isFinite(waste) ? { wastedTokens: Math.round(waste) } : {}),
  };
}
