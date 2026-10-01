/**
 * Wave 6 rotation world: forced upstream field rename (state → conclusion).
 *
 * A compiled tool encodes the world as it was. GitHub (and every other
 * JSON API) sometimes renames a field the agent already consumes. The live
 * tool keeps serving until a human Approves a replacement — but the
 * replacement must appear without anyone running `compileTraces` by hand.
 *
 * This is a product fixture, not the POC 8 sketch: real `compileTraces` +
 * `shadowProgram` run on the renamed traces, the canary queues a draft+knock,
 * and the live row stays On.
 *
 *   bun test benchmarks/campaign/upstream-rename.test.ts
 *
 * Pre-registered expect (ROADMAP §4.9) is `EXPECT` below. Do not retune
 * silent-drop / session-crosstalk / partial-iteration against this world.
 */
import type { StretchTrace } from "@eden/ir";
import { canaryWorkspaceDeps } from "../../apps/site/src/canary-bind";
import {
  maybeRecompile,
  maybeRecompileWorkspace,
  REFRESH_WAITING_COPY,
  type RecompileOutcome,
} from "../../apps/site/src/canary";
import { openDb, recordDeopt } from "../../apps/site/src/db";

/**
 * Pre-registered Wave 6 rotation verdict. Recorded before the run.
 * expect: field rename state→conclusion queues draft+knock via real compile/shadow; live stays On; human Approves.
 */
export const EXPECT =
  "field rename (state→conclusion): queued draft+knock via real compileTraces+shadowProgram; live stays On; human Approves; zero manual mining";

export const RENAMED_FIELD = { from: "state", to: "conclusion" } as const;

const LIVE_STEPS = [
  {
    id: "s1",
    kind: "cloud_http",
    name: "get_pr",
    method: "GET",
    commute: true,
    url: "https://api.github.com/repos/acme/app/pulls/{issue}",
  },
  {
    id: "s2",
    kind: "cloud_http",
    name: "get_files",
    method: "GET",
    commute: true,
    url: "https://api.github.com/repos/acme/app/pulls/{issue}/files",
  },
  {
    id: "s3",
    kind: "cloud_http",
    name: "get_status",
    method: "GET",
    commute: true,
    url: "https://api.github.com/repos/acme/app/pulls/{issue}/status",
  },
];

/** v1 upstream: the field everyone consumes is `state` (and `mergeable`). */
export function statusV1(): Record<string, unknown> {
  return {
    checks: [
      { name: "ci", state: "pass" },
      { name: "lint", state: "pass" },
    ],
    mergeable: true,
  };
}

/** v2 upstream: GitHub-style rename state→conclusion (and mergeable→is_mergeable). */
export function statusV2(): Record<string, unknown> {
  return {
    checks: [
      { name: "ci", conclusion: "pass" },
      { name: "lint", conclusion: "pass" },
    ],
    is_mergeable: true,
  };
}

function prBody(issue: string): Record<string, unknown> {
  return { title: `PR ${issue}`, author: "kai" };
}

function filesBody(i: number): Record<string, unknown> {
  return { count: 3 + i };
}

export function makeRenameTraces(version: 1 | 2, n = 5): StretchTrace[] {
  const status = version === 1 ? statusV1 : statusV2;
  return Array.from({ length: n }, (_, i) => {
    const issue = String(101 + i);
    const st = status();
    return {
      id: `rename-v${version}-${i}`,
      input: { issue },
      output: st,
      llmCalls: 3,
      prompt_tokens: 180,
      completion_tokens: 40,
      duration_ms: 900,
      cost_cents: 3,
      complete: true as const,
      events: [
        { name: "get_pr", args: { issue }, result: prBody(issue), ok: true, duration_ms: 40 },
        { name: "get_files", args: { issue }, result: filesBody(i), ok: true, duration_ms: 35 },
        { name: "get_status", args: { issue }, result: st, ok: true, duration_ms: 50 },
      ],
    };
  });
}

/**
 * Same v2 events, but no measured tokens and a synthetic wall clock — the
 * shadow gate must return INCONCLUSIVE, not a costume PASS. A stub that
 * ignores traces and always PASSes fails this trap.
 */
export function makeUnmeasuredRenameTraces(n = 5): StretchTrace[] {
  return makeRenameTraces(2, n).map((t) => {
    const { prompt_tokens: _p, completion_tokens: _c, ...rest } = t;
    return { ...rest, duration_ms: 200 * t.llmCalls };
  });
}

/** Too short to compile. A stub compiler that ignores traces would still queue. */
export function makeShortTraces(): StretchTrace[] {
  return Array.from({ length: 5 }, (_, i) => ({
    id: `short-${i}`,
    input: { issue: String(101 + i) },
    output: { ok: true },
    llmCalls: 1,
    prompt_tokens: 20,
    completion_tokens: 5,
    duration_ms: 40,
    cost_cents: 1,
    complete: true as const,
    events: [
      { name: "get_pr", args: { issue: String(101 + i) }, result: prBody(String(101 + i)), ok: true, duration_ms: 40 },
    ],
  }));
}

export type RenameRun = {
  expect: typeof EXPECT;
  compileCalls: number;
  seenBlob: string;
  outcome: RecompileOutcome | { action: "workspace-swept" };
  liveState: string;
  draftState: string | null;
  whenToUse: string | null;
  draftSteps: unknown;
  knockOnLive: boolean;
  liveId: string;
};

async function seedLive(db: Awaited<ReturnType<typeof openDb>>, workspaceId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, required_k)
     VALUES (?, ?, ?, ?, 'on', ?, ?, ?, 2)`,
    [
      id,
      workspaceId,
      `pr_status_${workspaceId}`,
      "test live tool",
      JSON.stringify(LIVE_STEPS),
      JSON.stringify(["get_pr", "get_files", "get_status"]),
      `fp/acme/pr-status/${workspaceId}`,
    ],
  );
  return id;
}

function wrapCompile(seen: { calls: number; blob: string }) {
  const bound = canaryWorkspaceDeps();
  return {
    ...bound,
    compileTracesFn: (traces: unknown[]) => {
      seen.calls += 1;
      seen.blob = JSON.stringify(traces);
      return bound.compileTracesFn(traces);
    },
  };
}

export async function runRenameViaCanary(opts: { traces: StretchTrace[]; tag: string }): Promise<RenameRun> {
  const db = await openDb(`/tmp/eden-rename-${opts.tag}-${Date.now()}.db`);
  const workspaceId = `ws_rename_${opts.tag}`;
  const liveId = await seedLive(db, workspaceId);
  await recordDeopt(db, workspaceId, liveId, { reason: "upstream renamed a field" });
  await recordDeopt(db, workspaceId, liveId, { reason: "upstream renamed a field" });
  const seen = { calls: 0, blob: "" };
  const outcome = await maybeRecompile(db, {
    workspace_id: workspaceId,
    tool_id: liveId,
    ...wrapCompile(seen),
    gatherTracesFn: async () => opts.traces,
  });
  return snapshot(db, liveId, seen, outcome);
}

/** Production entry: workspace sweep, same deps cluster.ts now passes. */
export async function runRenameViaWorkspace(opts: { traces: StretchTrace[]; tag: string }): Promise<RenameRun> {
  const db = await openDb(`/tmp/eden-rename-ws-${opts.tag}-${Date.now()}.db`);
  const workspaceId = `ws_rename_ws_${opts.tag}`;
  const liveId = await seedLive(db, workspaceId);
  await recordDeopt(db, workspaceId, liveId, { reason: "upstream renamed a field" });
  await recordDeopt(db, workspaceId, liveId, { reason: "upstream renamed a field" });
  const seen = { calls: 0, blob: "" };
  await maybeRecompileWorkspace(db, workspaceId, {
    ...wrapCompile(seen),
    gatherTracesFn: async () => opts.traces,
  });
  return snapshot(db, liveId, seen, { action: "workspace-swept" });
}

async function snapshot(
  db: Awaited<ReturnType<typeof openDb>>,
  liveId: string,
  seen: { calls: number; blob: string },
  outcome: RenameRun["outcome"],
): Promise<RenameRun> {
  const live = await db.get<{ state: string }>(`SELECT state FROM tool WHERE id = ?`, [liveId]);
  const draft = await db.get<{ state: string; when_to_use: string; steps: string }>(
    `SELECT state, when_to_use, steps FROM tool WHERE id != ?`,
    [liveId],
  );
  const knock = await db.get<{ tool_id: string }>(`SELECT tool_id FROM knock`);
  return {
    expect: EXPECT,
    compileCalls: seen.calls,
    seenBlob: seen.blob,
    outcome,
    liveState: live?.state ?? "missing",
    draftState: draft?.state ?? null,
    whenToUse: draft?.when_to_use ?? null,
    draftSteps: draft?.steps ? JSON.parse(draft.steps) : null,
    knockOnLive: knock?.tool_id === liveId,
    liveId,
  };
}
