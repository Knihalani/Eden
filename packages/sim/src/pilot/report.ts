/**
 * The pilot's report (F3, D489): the agent alone against the agent with Eden on the owner's own tasks, paired task by
 * task. The owner's blind marks are the measure (a model grader's verdicts, if the run had one, are shown beside them
 * and never replace them). Honest about size: a handful of tasks shows only large differences, and the report says
 * how large.
 */
import { backfillShares, type Background, type RunResult } from "../lab/ab-common";
import type { PilotMarks, PilotTask } from "./store";
import { taskId } from "./world";

export interface ArmSummary {
  tasks: number;
  /** The agent's bill, Eden's per-request calls, and the arm's share of Eden's background cards (`backgroundUsd`). */
  usdPerTask: number;
  /** Of `usdPerTask`: Eden's background cards, mostly a one-time read of the import, spread over the arm's requests. */
  backgroundUsd: number;
  wallMeanS: number;
  turns: number;
  toolCalls: number;
}

export interface PilotReport {
  alone: string;
  withEden: string;
  /** Tasks with facts, marked in both arms. */
  factTasks: number;
  raisedAlone: number;
  raisedWithEden: number;
  /** Tasks only one arm raised a fact on, and the exact two-sided sign test on them. */
  onlyWithEden: number;
  onlyAlone: number;
  p: number;
  /** Individual facts raised, of those marked. */
  facts: { total: number; alone: number; withEden: number };
  /** Answers the owner marked wrong or misleading, of those marked. */
  wrong: { marked: number; alone: number; withEden: number };
  /** The model grader's verdicts on the same tasks (any fact raised), when the run graded. */
  grader: { tasks: number; alone: number; withEden: number } | null;
  arms: Record<string, ArmSummary>;
  /** Requests both arms answered that the owner has not marked in both yet. */
  unmarked: number;
  /** Requests an arm failed or left empty: `annotate` cannot show them, so they are out of the pairing. */
  noAnswer: number;
}

/** The exact two-sided sign test: the chance of a split at least this uneven among `b + c` discordant tasks. */
export function signTest(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  let tail = 0;
  let term = 0.5 ** n;
  for (let i = 0; i <= Math.min(b, c); i++) {
    tail += term;
    term = (term * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * tail);
}

/** The fewest requests that must differ between the arms for p < 0.05, when all of them go one way: 6. */
export const MIN_DISCORDANT = 6;

export function buildReport(
  tasks: readonly PilotTask[],
  results: readonly RunResult[],
  marks: PilotMarks,
  alone = "tools",
  withEden = "eden",
  /** The run's background spend (`out.json`): Eden's cards are charged to no request, so they are added here. */
  background: readonly Background[] = [],
): PilotReport {
  const shares = backfillShares([...background]);
  const share = (r: RunResult) => shares.get(`${r.task}\u0000${r.condition}`) ?? 0;
  const by = new Map(results.map((r) => [`${r.task}|${r.condition}`, r]));
  const any = (m: Record<string, boolean> | undefined) => !!m && Object.values(m).some(Boolean);
  const out: PilotReport = {
    alone,
    withEden,
    factTasks: 0,
    raisedAlone: 0,
    raisedWithEden: 0,
    onlyWithEden: 0,
    onlyAlone: 0,
    p: 1,
    facts: { total: 0, alone: 0, withEden: 0 },
    wrong: { marked: 0, alone: 0, withEden: 0 },
    grader: null,
    arms: {},
    unmarked: 0,
    noAnswer: 0,
  };
  const graded = { tasks: 0, alone: 0, withEden: 0 };
  for (const t of tasks) {
    const id = taskId(t.id);
    const a = marks[id]?.[alone];
    const e = marks[id]?.[withEden];
    const ra = by.get(`${id}|${alone}`);
    const re = by.get(`${id}|${withEden}`);
    if (ra?.facts && re?.facts && t.facts.length) {
      graded.tasks++;
      graded.alone += any(ra.facts) ? 1 : 0;
      graded.withEden += any(re.facts) ? 1 : 0;
    }
    if (!a || !e) {
      // `annotate` shows only answers that exist and did not fail: a request missing one is never markable, so it is
      // counted apart rather than sent back to annotate.
      const usable = (r: RunResult | undefined) => !!r && !r.error && !!r.answer.trim();
      if (usable(ra) && usable(re)) out.unmarked++;
      else if (ra || re) out.noAnswer++;
      continue;
    }
    out.wrong.marked++;
    out.wrong.alone += a.wrong ? 1 : 0;
    out.wrong.withEden += e.wrong ? 1 : 0;
    if (!t.facts.length) continue;
    out.factTasks++;
    const [x, y] = [any(a.facts), any(e.facts)];
    out.raisedAlone += x ? 1 : 0;
    out.raisedWithEden += y ? 1 : 0;
    if (y && !x) out.onlyWithEden++;
    if (x && !y) out.onlyAlone++;
    for (const f of t.facts) {
      out.facts.total++;
      out.facts.alone += a.facts[f.id] ? 1 : 0;
      out.facts.withEden += e.facts[f.id] ? 1 : 0;
    }
  }
  out.p = signTest(out.onlyWithEden, out.onlyAlone);
  out.grader = graded.tasks ? graded : null;
  for (const arm of [alone, withEden]) {
    const rs = results.filter((r) => r.condition === arm && !r.error);
    const mean = (f: (r: RunResult) => number) => (rs.length ? rs.reduce((s, r) => s + f(r), 0) / rs.length : 0);
    out.arms[arm] = {
      tasks: rs.length,
      usdPerTask: mean((r) => r.costUsd + r.edenCostUsd + share(r)),
      backgroundUsd: mean(share),
      wallMeanS: mean((r) => r.wallMs / 1000),
      turns: mean((r) => r.modelCalls),
      toolCalls: mean((r) => r.toolCalls),
    };
  }
  return out;
}

export function renderReport(r: PilotReport): string {
  const pct = (n: number, d: number) => (d ? `${n} of ${d} (${Math.round((100 * n) / d)}%)` : "none marked");
  const lines = [
    `Pilot report: the agent alone (${r.alone}) against the agent with Eden (${r.withEden}), your marks, paired by task.`,
    "",
    `Requests where something mattered (${r.factTasks} marked in both arms):`,
    `  raised at least one fact that mattered: alone ${pct(r.raisedAlone, r.factTasks)}, with Eden ` +
      `${pct(r.raisedWithEden, r.factTasks)}`,
    `  only with Eden: ${r.onlyWithEden}; only alone: ${r.onlyAlone}; exact sign test p = ${r.p.toFixed(3)}`,
    `  individual facts raised: alone ${pct(r.facts.alone, r.facts.total)}, with Eden ` +
      `${pct(r.facts.withEden, r.facts.total)}`,
    "",
    `Answers you marked wrong or misleading (${r.wrong.marked} requests marked in both arms): alone ` +
      `${r.wrong.alone}, with Eden ${r.wrong.withEden}`,
  ];
  if (r.grader) {
    lines.push(
      "",
      `The model grader on the same requests (${r.grader.tasks} graded; shown for comparison, not the measure): alone ` +
        `${r.grader.alone}, with Eden ${r.grader.withEden}`,
    );
  }
  lines.push("", "Per request (model calls billed to your key; Eden's reader and background cards are in its arm):");
  for (const [arm, a] of Object.entries(r.arms)) {
    const cards = a.backgroundUsd > 0 ? ` ($${a.backgroundUsd.toFixed(5)} of it cards, mostly a one-time read)` : "";
    lines.push(
      `  ${arm}: ${a.tasks} answered, $${a.usdPerTask.toFixed(5)} a request${cards}, ${a.wallMeanS.toFixed(2)} s, ` +
        `${a.turns.toFixed(2)} model turns, ${a.toolCalls.toFixed(2)} tool calls`,
    );
  }
  lines.push(
    "",
    `How much this can show: with ${r.factTasks} requests, a difference is distinguishable from chance (p < 0.05) ` +
      `only if several requests differ between the arms and nearly all go one way: ${MIN_DISCORDANT} against 0 at ` +
      "the least (8 against 1 also passes; 5 against 0 does not). " +
      "Treat a smaller pilot as a look at real answers, not a measurement.",
  );
  if (r.noAnswer) {
    lines.push(
      `${r.noAnswer} requests have no usable answer in one arm (an error, the cap, or an empty reply): they are left ` +
        "out of the pairing above.",
    );
  }
  if (r.unmarked) lines.push(`${r.unmarked} answered requests have no marks in both arms yet: run \`pilot annotate\`.`);
  return lines.join("\n");
}
