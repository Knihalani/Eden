/**
 * Wave 13.2 rotation: read-only production-shaped speculation, not fastdesk.
 *
 * GitHub-like getIssue / getComments / getChecks with real tool latency.
 * WIN on wall because turnBoundary starts the compiled stretch during
 * think-time (session THINK_MS = 120). unique-work / creative stay parity ±1%.
 *
 * Pre-registered expect is `EXPECT` below — recorded before the run.
 */

import type { StretchProgram } from "@eden/ir";
import { decide, type Sample } from "@eden/measure";
import { createState, turnBoundary, wrapTools, type ToolDef, type WrapState } from "@eden/wrap";
import type { World } from "./worlds";
import { createCreative, createNoise } from "./negative-worlds";

/** Session think-time. Speculation must overlap this, not add to it. */
export const THINK_MS = 120;

/**
 * Pre-registered Wave 13.2 rotation verdict. Recorded before the run.
 * expect: wall WIN on GitHub-like read-only speculation overlapping think-time;
 * unique-work / creative parity ±1%. Not fastdesk. Do not quote PASTE 48.5%.
 */
export const EXPECT =
  "WIN on wall: GitHub-like getIssue/getComments/getChecks speculation overlaps think-time (THINK_MS=120); unique-work/creative parity ±1%. Not fastdesk.";

/** Production-like REST latency. Instant tools would hide the PASTE cost. */
export const ISSUE_MS = 80;
export const COMMENTS_MS = 80;
export const CHECKS_MS = 80;

export const ISSUE_IDS = ["42", "43", "101", "102", "201", "202", "301", "302"] as const;

const liveManifest = {
  llmReduction: 8,
  latencyReduction: 8,
  costReduction: 8,
  skipRateBefore: 0.2,
  skipRateAfter: 0,
  nShadow: 6,
};

export type GithubReview = {
  id: string;
  title: string;
  comments: string[];
  checks: string[];
};

export function createGithubReview(): World {
  const seen: Record<string, number> = {};
  return {
    name: "github-review",
    island: () => async () => ({ ok: false }),
    tools: () => ({
      getIssue: {
        description: "GET /repos/{owner}/{repo}/issues/{id}",
        execute: async ({ id }) => {
          await Bun.sleep(ISSUE_MS);
          const n = String(id);
          seen[n] = (seen[n] ?? 0) + 1;
          return { id: n, title: `Issue ${n}`, number: Number(n) };
        },
      },
      getComments: {
        description: "GET /repos/{owner}/{repo}/issues/{id}/comments",
        execute: async ({ id }) => {
          await Bun.sleep(COMMENTS_MS);
          const n = String(id);
          return { id: n, comments: [`comment-on-${n}`] };
        },
      },
      getChecks: {
        description: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        execute: async ({ id }) => {
          await Bun.sleep(CHECKS_MS);
          const n = String(id);
          return {
            id: n,
            title: `Issue ${n}`,
            comments: [`comment-on-${n}`],
            checks: ["ci", "lint"],
          } satisfies GithubReview;
        },
      },
    }),
    async *script(goal) {
      const id = String(goal.id);
      yield { tool: "getIssue", args: { id } };
      yield { tool: "getComments", args: { id } };
      yield { tool: "getChecks", args: { id } };
    },
    done: (v) => Array.isArray((v as { checks?: unknown })?.checks),
    terminal: "getChecks",
    check() {
      return [];
    },
  };
}

export function githubReviewProgram(): StretchProgram {
  return {
    id: "gh-review",
    version: "1",
    name: "review_issue",
    description:
      "Read-only GitHub review: issue, comments, checks. Use this instead of calling getIssue, getComments, and getChecks in sequence.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: ["getIssue", "getComments", "getChecks"],
    steps: [
      { id: "issue", kind: "tool", tool: "getIssue", args: { id: { kind: "input", path: "id" } }, readOnly: true },
      {
        id: "comments",
        kind: "tool",
        tool: "getComments",
        args: { id: { kind: "from", step: "issue", path: "id" } },
        readOnly: true,
      },
      {
        id: "checks",
        kind: "tool",
        tool: "getChecks",
        args: { id: { kind: "from", step: "comments", path: "id" } },
        readOnly: true,
      },
    ],
    returns: { kind: "from", step: "checks", path: "" },
    contract: {
      witnesses: ISSUE_IDS.length,
      minLlmReduction: 2,
      allowExact: true,
      envelope: { inputs: { id: [...ISSUE_IDS] } },
    },
    manifest: liveManifest,
  };
}

function wrapWorld(world: World, programs: StretchProgram[]): { state: WrapState; call: (n: string, a: Record<string, unknown>) => Promise<unknown>; execs: { n: number } } {
  const execs = { n: 0 };
  const defs = world.tools();
  const counted: Record<string, ToolDef> = {};
  for (const [name, def] of Object.entries(defs)) {
    counted[name] = {
      description: def.description,
      execute: async (args) => {
        execs.n++;
        return await def.execute(args);
      },
    };
  }
  const state = createState({ programs });
  const wrapped = wrapTools(counted, state);
  const call = async (n: string, a: Record<string, unknown>) => {
    const t = (wrapped as Record<string, ToolDef | undefined>)[n];
    if (!t) throw new Error(`no such tool: ${n}`);
    return await t.execute(a);
  };
  return { state, call, execs };
}

export type StretchWall = { wall_ms: number; execs: number; value: unknown };

/**
 * One compiled GitHub review stretch.
 *
 * `speculate`: call turnBoundary BEFORE think-time so tool latency overlaps
 * the 120ms think. Control omits that call — first stretch waits think+tools
 * serial, which is the local high-water wrap already ships.
 */
export async function runGithubStretch(opts: { id: string; speculate: boolean }): Promise<StretchWall> {
  const world = createGithubReview();
  const { state, call, execs } = wrapWorld(world, [githubReviewProgram()]);
  const t0 = performance.now();
  if (opts.speculate) turnBoundary(state, { program: "gh-review", input: { id: opts.id } });
  await Bun.sleep(THINK_MS);
  const value = await call("getIssue", { id: opts.id });
  return { wall_ms: performance.now() - t0, execs: execs.n, value };
}

export async function runGithubCampaign(): Promise<{
  verdict: string;
  controlMean: number;
  treatmentMean: number;
  relative: number;
  p: number;
  blocks: number;
}> {
  const control: Sample[] = [];
  const treatment: Sample[] = [];
  for (let i = 0; i < ISSUE_IDS.length; i++) {
    const id = ISSUE_IDS[i]!;
    const task = `gh-${id}`;
    const c = await runGithubStretch({ id, speculate: false });
    const t = await runGithubStretch({ id, speculate: true });
    control.push({ task, repeat: 0, value: c.wall_ms });
    treatment.push({ task, repeat: 0, value: t.wall_ms });
  }
  const d = decide({ treatment, control, higherIsBetter: false });
  const relative = d.controlMean === 0 ? 0 : d.delta.point / d.controlMean;
  return {
    verdict: d.verdict,
    controlMean: d.controlMean,
    treatmentMean: d.treatmentMean,
    relative,
    p: d.p,
    blocks: d.blocks,
  };
}

async function runNoiseLike(worldFactory: () => World, speculate: boolean, goal: Record<string, unknown>): Promise<StretchWall> {
  const world = worldFactory();
  const { state, call, execs } = wrapWorld(world, []);
  const t0 = performance.now();
  const gen = world.script(goal, () => 0.5);
  let sent: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
  let last: unknown;
  for (;;) {
    const next = await gen.next(sent as never);
    if (next.done) break;
    if (speculate) turnBoundary(state, { input: next.value.args });
    const value = await call(next.value.tool, next.value.args);
    last = value;
    sent = { ok: true, value };
  }
  return { wall_ms: performance.now() - t0, execs: execs.n, value: last };
}

export const PARITY_BAND = 0.01;

export async function runParity(kind: "unique-work" | "creative"): Promise<{
  relative: number;
  controlMean: number;
  treatmentMean: number;
  execEqual: boolean;
  withinBand: boolean;
}> {
  const factory = kind === "unique-work" ? createNoise : createCreative;
  const goals =
    kind === "unique-work"
      ? Array.from({ length: 12 }, (_, i) => ({ id: `N-${i}` }))
      : Array.from({ length: 12 }, (_, i) => ({ id: `C-${i}` }));
  const control: Sample[] = [];
  const treatment: Sample[] = [];
  let execEqual = true;
  for (let i = 0; i < goals.length; i++) {
    const goal = goals[i]!;
    // Counterbalance arm order so a drifting clock cannot fake a ±1% miss.
    const firstTreat = i % 2 === 1;
    const a = await runNoiseLike(factory, firstTreat, goal);
    const b = await runNoiseLike(factory, !firstTreat, goal);
    const c = firstTreat ? b : a;
    const t = firstTreat ? a : b;
    if (c.execs !== t.execs) execEqual = false;
    control.push({ task: `${kind}-${i}`, repeat: 0, value: c.wall_ms });
    treatment.push({ task: `${kind}-${i}`, repeat: 0, value: t.wall_ms });
  }
  const d = decide({ treatment, control, higherIsBetter: false });
  const relative = d.controlMean === 0 ? 0 : d.delta.point / d.controlMean;
  return {
    relative,
    controlMean: d.controlMean,
    treatmentMean: d.treatmentMean,
    execEqual,
    withinBand: Math.abs(relative) <= PARITY_BAND,
  };
}

export { createCreative, createNoise };
