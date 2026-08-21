export type WorkflowItem = {
  id: string;
  name: string;
  state: string;
  at: number;
  runs: number;
  fails: number;
  llmTimes: number;
};

export type RequestItem = {
  id: string;
  name: string;
  verdict: string;
  refused: boolean;
  at: number;
  failureMode?: string;
  firstWarningAt?: number;
};

export type DayPoint = {
  label: string;
  runs: number;
};

export type Activity = {
  runs: number;
  compiled: number;
  waiting: number;
  fails: number;
  llmTimes: number;
  tokensSaved: number;
  failed: boolean;
  series: DayPoint[];
  workflows: WorkflowItem[];
  requests: RequestItem[];
};

export const EMPTY_SERIES: DayPoint[] = emptySeries();

export const EMPTY_ACTIVITY: Activity = {
  runs: 0,
  compiled: 0,
  waiting: 0,
  fails: 0,
  llmTimes: 0,
  tokensSaved: 0,
  failed: false,
  series: EMPTY_SERIES,
  workflows: [],
  requests: [],
};

export type InboxSlice = {
  candidates?: unknown[];
  live?: unknown[];
  savings?: { runs?: number; live?: number; llmReductionMean?: number; tokensSavedMean?: number; timeSavedMsMean?: number };
};

const DEMO_IDS = new Set(["cand_resolve", "cand_pending", "cand_refused", "live_notify", "live_paused"]);

export function activityFromInbox(inbox: InboxSlice | null | undefined, receipts: unknown[] = []): Activity {
  if (!inbox) return emptyActivity();
  const workflows = (inbox.live ?? [])
    .flatMap((row) => {
      const item = asWorkflow(row);
      return item && !DEMO_IDS.has(item.id) ? [item] : [];
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
  return {
    runs,
    compiled,
    waiting,
    fails: requestFails + receiptFails,
    llmTimes: 0,
    tokensSaved: Math.max(0, Math.round(inbox.savings?.tokensSavedMean ?? 0)),
    failed: false,
    series: receiptSeries(receipts),
    workflows,
    requests,
  };
}

export function emptyActivity(): Activity {
  return { ...EMPTY_ACTIVITY, workflows: [], requests: [], series: emptySeries() };
}

export function failedActivity(): Activity {
  return { ...emptyActivity(), failed: true };
}

export function formatCount(n: number) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(n)));
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

export function workflowStatus(state: string) {
  return state === "paused" ? "Paused" : "Live";
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
  return mode;
}

export function inboxItems(activity: Activity): InboxItem[] {
  const requests = Array.isArray(activity.requests) ? activity.requests : [];
  const workflows = Array.isArray(activity.workflows) ? activity.workflows : [];
  return [
    ...requests.map((item) => {
      const base = requestStatus(item.verdict, item.refused);
      const fail = item.failureMode ? failureModeLabel(item.failureMode) : "";
      const at = item.firstWarningAt != null ? ` at ${item.firstWarningAt}` : "";
      return {
        id: `request:${item.id}`,
        name: item.name,
        href: requestPath(item.id),
        kind: "request" as const,
        kindLabel: "Request",
        status: fail ? `${base} · ${fail}${at}` : base,
      };
    }),
    ...workflows.map((item) => ({
      id: `workflow:${item.id}`,
      name: item.name,
      href: livePath(item.id),
      kind: "workflow" as const,
      kindLabel: "Workflow",
      status: workflowStatus(item.state),
    })),
  ];
}

function emptySeries(): DayPoint[] {
  return receiptSeries([]);
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

function asWorkflow(value: unknown): WorkflowItem | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || !row.id) return null;
  const state = row.state === "paused" || row.state === "live" ? row.state : null;
  if (!state) return null;
  const last = asRecord(row.last);
  const stats = asRecord(row.stats);
  return {
    id: row.id,
    name: typeof row.name === "string" && row.name ? row.name : "Workflow",
    state,
    at: asTime(row.updated_at, last?.created_at, row.created_at),
    runs: asCount(stats?.n),
    fails: asCount(stats?.fail),
    llmTimes: 0,
  };
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
  const origin = program ? asRecord(program.origin) : asRecord(row.origin);
  const failureMode = typeof origin?.mode === "string" && origin.mode !== "happy" ? origin.mode : undefined;
  const warnAt = Number(origin?.firstWarningAt);
  return {
    id: row.id,
    name: fromProgram || sequence.join(" · ") || "Request",
    verdict: typeof row.verdict === "string" && row.verdict ? row.verdict : "pending",
    refused: Boolean(refusal),
    at: asTime(row.created_at),
    ...(failureMode ? { failureMode } : {}),
    ...(Number.isFinite(warnAt) ? { firstWarningAt: Math.round(warnAt) } : {}),
  };
}
