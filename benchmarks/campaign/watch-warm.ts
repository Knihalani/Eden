/**
 * Wave 14.1 rotation: watch-time warming of the next compiled read-only
 * program's first-wave reads, while the current stretch is still running.
 *
 * Not turn-boundary speculation (that starts the whole next stretch during
 * think). Not playback warmWorkspaceBundle (scored warming at MCP init).
 * Mutating never pre-executed. Control is `EDEN_WATCH_WARM=0`.
 *
 * Pre-registered expect is `EXPECT` below — recorded before the run.
 */

import type { StretchProgram } from "@eden/ir";
import {
  createState,
  warmHitRate,
  warmStats,
  wrapTools,
  type ToolDef,
  type WrapState,
} from "@eden/wrap";

/** Pre-registered Wave 14.1 expect. Recorded before the run. */
export const EXPECT =
  "treatment first-wave hit-rate > control (EDEN_WATCH_WARM=0); mutating execute count 0. Not turnBoundary, not warmWorkspaceBundle.";

/** Current stretch latency — warming must overlap this, not wait for think. */
export const CURRENT_MS = 80;
/** Next-program first-wave latency (each of two independent reads). */
export const NEXT_MS = 40;

export const ISSUE_IDS = ["10", "11", "12", "13", "14", "15"] as const;

const liveManifest = {
  llmReduction: 8,
  latencyReduction: 8,
  costReduction: 8,
  skipRateBefore: 0.2,
  skipRateAfter: 0,
  nShadow: 6,
};

export function currentProgram(): StretchProgram {
  return {
    id: "fetch-issue",
    version: "1",
    name: "fetch_issue",
    description: "Read-only issue + comments. Use this instead of getIssue then getComments.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: ["getIssue", "getComments"],
    steps: [
      { id: "issue", kind: "tool", tool: "getIssue", args: { id: { kind: "input", path: "id" } }, readOnly: true },
      {
        id: "comments",
        kind: "tool",
        tool: "getComments",
        args: { id: { kind: "from", step: "issue", path: "id" } },
        readOnly: true,
      },
    ],
    returns: { kind: "from", step: "comments", path: "" },
    contract: {
      witnesses: ISSUE_IDS.length,
      minLlmReduction: 2,
      allowExact: true,
      envelope: { inputs: { id: [...ISSUE_IDS] } },
    },
    manifest: liveManifest,
  };
}

export function nextProgram(): StretchProgram {
  return {
    id: "fetch-meta",
    version: "1",
    name: "fetch_meta",
    description: "Read-only labels, assignees, timeline.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: ["getLabels", "getAssignees", "getTimeline"],
    steps: [
      { id: "labels", kind: "tool", tool: "getLabels", args: { id: { kind: "input", path: "id" } }, readOnly: true },
      {
        id: "assignees",
        kind: "tool",
        tool: "getAssignees",
        args: { id: { kind: "input", path: "id" } },
        readOnly: true,
      },
      {
        id: "timeline",
        kind: "tool",
        tool: "getTimeline",
        args: { id: { kind: "from", step: "labels", path: "id" } },
        readOnly: true,
      },
    ],
    returns: { kind: "from", step: "timeline", path: "" },
    contract: {
      witnesses: ISSUE_IDS.length,
      minLlmReduction: 2,
      allowExact: true,
      envelope: { inputs: { id: [...ISSUE_IDS] } },
    },
    manifest: liveManifest,
  };
}

export function writeProgram(): StretchProgram {
  return {
    id: "mutate",
    version: "1",
    name: "close_issue",
    description: "Mutating close.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: ["getIssue", "writeRecord"],
    steps: [
      { id: "issue", kind: "tool", tool: "getIssue", args: { id: { kind: "input", path: "id" } } },
      { id: "write", kind: "tool", tool: "writeRecord", args: { id: { kind: "input", path: "id" } } },
    ],
    returns: { kind: "from", step: "write", path: "" },
    contract: {
      witnesses: ISSUE_IDS.length,
      minLlmReduction: 2,
      allowExact: true,
      envelope: { inputs: { id: [...ISSUE_IDS] } },
    },
    manifest: liveManifest,
  };
}

type Execs = { n: number; writes: number; byName: Record<string, number> };

function wrapPair(
  programs: StretchProgram[],
  opts?: { currentMs?: number; nextMs?: number },
): { state: WrapState; call: (n: string, a: Record<string, unknown>) => Promise<unknown>; execs: Execs } {
  const execs: Execs = { n: 0, writes: 0, byName: {} };
  const currentMs = opts?.currentMs ?? CURRENT_MS;
  const nextMs = opts?.nextMs ?? NEXT_MS;
  const counted: Record<string, ToolDef> = {
    getIssue: {
      description: "GET issue",
      execute: async ({ id }) => {
        execs.n++;
        execs.byName.getIssue = (execs.byName.getIssue ?? 0) + 1;
        await Bun.sleep(currentMs);
        return { id, title: `Issue ${id}` };
      },
    },
    getComments: {
      description: "GET comments",
      execute: async ({ id }) => {
        execs.n++;
        execs.byName.getComments = (execs.byName.getComments ?? 0) + 1;
        await Bun.sleep(currentMs);
        return { id, comments: [`c-${id}`] };
      },
    },
    getLabels: {
      description: "GET labels",
      execute: async ({ id }) => {
        execs.n++;
        execs.byName.getLabels = (execs.byName.getLabels ?? 0) + 1;
        await Bun.sleep(nextMs);
        return { id, labels: ["bug"] };
      },
    },
    getAssignees: {
      description: "GET assignees",
      execute: async ({ id }) => {
        execs.n++;
        execs.byName.getAssignees = (execs.byName.getAssignees ?? 0) + 1;
        await Bun.sleep(nextMs);
        return { id, assignees: ["kai"] };
      },
    },
    getTimeline: {
      description: "GET timeline",
      execute: async ({ id }) => {
        execs.n++;
        execs.byName.getTimeline = (execs.byName.getTimeline ?? 0) + 1;
        return { id, events: ["opened"] };
      },
    },
    writeRecord: {
      description: "POST write",
      execute: async ({ id }) => {
        execs.n++;
        execs.writes++;
        execs.byName.writeRecord = (execs.byName.writeRecord ?? 0) + 1;
        return { written: true, id };
      },
    },
  };
  const state = createState({ programs });
  const wrapped = wrapTools(counted, state);
  const call = async (n: string, a: Record<string, unknown>) => {
    const t = (wrapped as Record<string, ToolDef | undefined>)[n];
    if (!t) throw new Error(`no such tool: ${n}`);
    return await t.execute(a);
  };
  return { state, call, execs };
}

export type WarmRun = {
  hits: number;
  lookups: number;
  rate: number;
  writes: number;
  mutatingExecutes: number;
  value: unknown;
};

/**
 * One current-then-next pair. Treatment leaves `EDEN_WATCH_WARM` default-on.
 * Control sets it to `0`. Speculate is off so the meter is watch-warm only.
 */
export async function runWatchWarm(opts: { id: string; warm: boolean }): Promise<WarmRun> {
  const prevWarm = process.env.EDEN_WATCH_WARM;
  const prevSpec = process.env.EDEN_SPECULATE;
  process.env.EDEN_SPECULATE = "0";
  if (opts.warm) delete process.env.EDEN_WATCH_WARM;
  else process.env.EDEN_WATCH_WARM = "0";
  try {
    const { state, call, execs } = wrapPair([currentProgram(), nextProgram()]);
    await call("fetch_issue", { id: opts.id });
    const value = await call("fetch_meta", { id: opts.id });
    const rate = warmHitRate(state, "fetch-meta");
    const stats = warmStats(state);
    return {
      hits: rate.hits,
      lookups: rate.lookups,
      rate: rate.rate,
      writes: execs.writes,
      mutatingExecutes: stats.mutatingExecutes,
      value,
    };
  } finally {
    if (prevWarm === undefined) delete process.env.EDEN_WATCH_WARM;
    else process.env.EDEN_WATCH_WARM = prevWarm;
    if (prevSpec === undefined) delete process.env.EDEN_SPECULATE;
    else process.env.EDEN_SPECULATE = prevSpec;
  }
}

export async function runMutatingNext(id: string): Promise<{ writes: number; mutatingExecutes: number }> {
  const prevWarm = process.env.EDEN_WATCH_WARM;
  const prevSpec = process.env.EDEN_SPECULATE;
  delete process.env.EDEN_WATCH_WARM;
  process.env.EDEN_SPECULATE = "0";
  try {
    const { state, call, execs } = wrapPair([currentProgram(), writeProgram()]);
    await call("fetch_issue", { id });
    await Bun.sleep(20);
    const stats = warmStats(state);
    return { writes: execs.writes, mutatingExecutes: stats.mutatingExecutes };
  } finally {
    if (prevWarm === undefined) delete process.env.EDEN_WATCH_WARM;
    else process.env.EDEN_WATCH_WARM = prevWarm;
    if (prevSpec === undefined) delete process.env.EDEN_SPECULATE;
    else process.env.EDEN_SPECULATE = prevSpec;
  }
}

export async function runWatchWarmCampaign(): Promise<{
  controlHits: number;
  treatmentHits: number;
  controlLookups: number;
  treatmentLookups: number;
  controlRate: number;
  treatmentRate: number;
  mutatingWrites: number;
  mutatingExecutes: number;
  n: number;
}> {
  let controlHits = 0;
  let treatmentHits = 0;
  let controlLookups = 0;
  let treatmentLookups = 0;
  for (const id of ISSUE_IDS) {
    const c = await runWatchWarm({ id, warm: false });
    const t = await runWatchWarm({ id, warm: true });
    controlHits += c.hits;
    treatmentHits += t.hits;
    controlLookups += c.lookups;
    treatmentLookups += t.lookups;
  }
  const mut = await runMutatingNext(ISSUE_IDS[0]!);
  return {
    controlHits,
    treatmentHits,
    controlLookups,
    treatmentLookups,
    controlRate: controlLookups === 0 ? 0 : controlHits / controlLookups,
    treatmentRate: treatmentLookups === 0 ? 0 : treatmentHits / treatmentLookups,
    mutatingWrites: mut.writes,
    mutatingExecutes: mut.mutatingExecutes,
    n: ISSUE_IDS.length,
  };
}
