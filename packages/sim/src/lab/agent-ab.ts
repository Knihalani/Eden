#!/usr/bin/env bun
/**
 * Does Eden help an agent finish tasks, against the same agent given plain search tools? (docs/research/agent-ab.md)
 *
 * One simulated world per seed (≈1,500 items over mail, calendar, docs, CRM and chat, behind the realistic
 * connector profiles). Its sessions' tasks that need facts from the user's sources (a user request, or a message
 * arriving) are given to the same model-driven agent under each condition:
 *
 * - none:   no access to the user's data (the floor: what the request alone allows);
 * - tools:  a search tool per source, as an agent is usually built;
 * - eden:   Eden beside the agent (context injected before the model call, `ask_context` as its only tool);
 * - both:   the search tools, with Eden's injected context too (Eden sees the agent's tool results);
 * - eden-judge, both-judge: as eden and both, with Eden's model judge on (`--judge`).
 *
 * A grader model reads each answer and says which of the task's needed facts it states; the answer's spend,
 * tokens, model calls and wall time are recorded. Off-world requests ("write a haiku") measure what each condition
 * costs when nothing in the sources helps. Spend stops at `--budget` dollars (OpenRouter's reported cost).
 *
 *   OPENROUTER_API_KEY=… bun packages/sim/src/lab/agent-ab.ts [--seeds 41,42,43] [--tasks 30] [--offworld 5]
 *     [--conditions none,tools,eden,both] [--judge] [--model z-ai/glm-5.3-flash] [--grader anthropic/claude-haiku-5.5]
 *     [--budget 3] [--out results.json] [--merge earlier.json] [--suite lookups|hidden|heldout-all|all|a,b]
 *     [--dry]
 *
 * --suite hidden runs the hidden-context tasks instead (hidden-context.ts, docs/research/agent-hidden.md): requests
 * whose answer depends on something they do not ask about, planted in each world. Any suite of `suites.ts` can be
 * named, or several (a comma list, `heldout-all`, `all`): each suite is planted in its own copy of each world, and
 * every task records its suite. --dry builds the tasks and prints their counts, with no model call and no key.
 *
 * --merge keeps an earlier run's results for the conditions not listed in --conditions (same seeds and task counts),
 * re-runs the listed ones, and grades every result that has no grade yet.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, OpenRouterModel } from "@eden/llm";
import type { AgentEvent, Injection } from "@eden/protocol";
import { QueryPlanner } from "@eden/sources";
import { REALISTIC, simSources, type SimSource } from "../sources";
import type { World } from "../world";
import {
  ASK_DESCRIPTION,
  chat as chatVia,
  emptyResult,
  grade as gradeVia,
  MAX_STEPS,
  OverBudget,
  render,
  searchToolSpec,
  systemPrompt,
  TOOL_ITEMS,
  userPrompt,
  worldOf as worldVia,
  type Meter,
  type Msg,
  type RunResult,
  type Task,
} from "./ab-common";
import { parseSuites } from "./suites";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const DRY = args.includes("--dry");
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY && !DRY) throw new Error("needs OPENROUTER_API_KEY");
const SEEDS = opt("seeds", "41,42,43").split(",").map(Number);
const MAX_TASKS = Number(opt("tasks", "30"));
const OFFWORLD = Number(opt("offworld", "5"));
const MODEL = opt("model", "z-ai/glm-5.3-flash");
const GRADER = opt("grader", "anthropic/claude-haiku-5.5");
const BUDGET = Number(opt("budget", "3"));
const JUDGE = args.includes("--judge");
const CONDITIONS = opt(
  "conditions",
  JUDGE ? "none,tools,eden,both,eden-judge,both-judge" : "none,tools,eden,both",
).split(",");
const OUT = opt("out", "agent-ab.json");
const SUITE = opt("suite", "lookups");
// `lookups` is the sessions' fact-needing tasks; anything else names hidden-context suites (suites.ts).
const LOOKUPS = SUITE === "lookups";
const SUITE_LIST = LOOKUPS ? ["lookups"] : parseSuites(SUITE);

let spent = 0;
// The in-house loop's spend rule: a call is refused once the budget is spent.
const meter: Meter = {
  before: () => {
    if (spent >= BUDGET) throw new OverBudget(`budget $${BUDGET} spent`);
  },
  after: (cost) => {
    spent += cost;
  },
};
const chat = (model: string, messages: Msg[], tools?: unknown[], json = false) =>
  chatVia(KEY!, meter, model, messages, tools, json);

const searchTools = (sources: SimSource[]) =>
  sources.map((s) => ({
    type: "function" as const,
    function: {
      ...searchToolSpec(s),
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to search for" } },
        required: ["query"],
      },
    },
  }));

const ASK_TOOL = {
  type: "function" as const,
  function: {
    name: "ask_context",
    description: ASK_DESCRIPTION,
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
};

/** Engine settings by condition suffix ("eden-judge+p"): the measured settings of docs/research/lean-probes.md. */
const FULL = {
  probes: true,
  probeCalls: 4,
  compactInjection: true,
  fallbackAgree: true,
  judgeConfident: true,
  judgeAgreed: false,
  judgeCandidates: 4,
};
const SETTINGS: Record<string, Record<string, unknown>> = {
  p: { probes: true },
  f: FULL,
  g: { ...FULL, judgeCandidates: 6 },
  p4: { probes: true, probeCalls: 4 },
  pc: { probes: true, compactInjection: true },
  pj: { probes: true, judgeConfident: true },
  // D48's candidate: probes, compaction, the no-model grounds and the judged contested sure set.
  C: {
    probes: true,
    compactInjection: true,
    quietSettled: true,
    groundAway: true,
    judgeContested: true,
    judgeItemBytes: 200,
  },
};
// C with the lookup's planner and probes sharing their calls, and the topic probe only when no one is named.
SETTINGS.C2 = { ...SETTINGS.C, probeShare: true, probeTopicAlone: true };
// D48's measured configuration: C2 with the no-model fallback for requests that ask about something they name.
SETTINGS.F = { ...SETTINGS.C2, fallbackAsks: true };

/** One world under one condition: a fresh Eden (if any) sees the world's tasks in order, as it would in use. */
async function runWorld(world: World, seed: number, tasks: Task[], condition: string): Promise<RunResult[]> {
  const sources = simSources(world, REALISTIC, 0, seed);
  // A suffix ("+p", "+f", ...) runs Eden with that variant's settings (`SETTINGS`); the rest is the condition.
  const plus = condition.lastIndexOf("+");
  const variant = plus > 0 ? SETTINGS[condition.slice(plus + 1)] : undefined;
  if (plus > 0 && !variant) throw new Error(`unknown variant in ${condition}: ${Object.keys(SETTINGS).join(", ")}`);
  const base = plus > 0 ? condition.slice(0, plus) : condition;
  const useEden = base !== "none" && base !== "tools";
  const useTools = base === "tools" || base.startsWith("both");
  const judge = base.endsWith("-judge");
  const scope = { tenantId: "ab", userId: `w${seed}` };
  let clock = world.now;
  const partner = useEden
    ? new ContextPartner({
        sources: async () => sources,
        sourceMap: new SourceMap(":memory:", { seed }),
        cache: new ItemCache(),
        budget: new Budget(),
        // The product's routing: zero-retention endpoints only (OpenRouterModel's default).
        model: judge ? new OpenRouterModel({ apiKey: KEY!, model: MODEL }) : null,
        planner: new QueryPlanner({ seed }),
        now: () => clock,
        config: variant ?? {},
        // Charged to the task whose session the trace is from: a slow-path verdict can land after it ended.
        onTrace: (t) => {
          const owner = bySession.get(t.sessionId);
          if (owner) {
            owner.edenModelCalls += t.modelCalls;
            owner.edenCostUsd += t.costUsd;
          }
          spent += t.costUsd;
        },
      })
    : null;
  const tools = [...(useTools ? searchTools(sources) : []), ...(useEden && !useTools ? [ASK_TOOL] : [])];
  const out: RunResult[] = [];
  const bySession = new Map<string, RunResult>();
  let previous: { sessionId: string; r: RunResult } | null = null;
  // Context Eden queued for a task after its agent had answered: counted (it reached no answer), then the session ends.
  const closePrevious = async () => {
    if (!partner || !previous) return;
    const who = { ...scope, sessionId: previous.sessionId };
    previous.r.lateItems = partner.takePending(who).reduce((n, i) => n + i.citations.length, 0);
    await partner.observe({ ...who, at: clock, kind: "session_end" });
    previous = null;
  };
  for (const task of tasks) {
    clock += 3_600_000; // an hour between tasks: Eden's clock, for its caches and planner
    const sessionId = task.id;
    const ev = (e: Record<string, unknown>) => ({ ...scope, sessionId, at: clock, ...e }) as AgentEvent;
    const r: RunResult = emptyResult(task.id, condition);
    await closePrevious();
    bySession.set(sessionId, r);
    const t0 = performance.now();
    try {
      const messages: Msg[] = [
        { role: "system", content: systemPrompt(world, { lookups: LOOKUPS, data: useTools || useEden }) },
        { role: "user", content: userPrompt(task) },
      ];
      const injected: Injection[] = [];
      if (partner) {
        await partner.observe(ev({ kind: "session_start", agent: "agent-ab" }));
        const arriving = task.event === "external" ? { source: "gmail" } : {};
        const first = await partner.observe(ev({ kind: task.event, text: task.text, ...arriving }), {
          waitMs: 3_000,
        });
        if (first.injection) injected.push(first.injection);
      }
      for (let step = 0; step < MAX_STEPS; step++) {
        if (partner) injected.push(...partner.takePending({ ...scope, sessionId }));
        const fresh = injected.splice(0);
        for (const i of fresh) {
          r.injectedItems += i.citations.length;
          r.injectedChars += i.text.length;
        }
        if (fresh.length) {
          // As withContext (@eden/client): Eden's context as a system message before the latest user message.
          const at = messages.map((m) => m.role).lastIndexOf("user");
          messages.splice(at, 0, { role: "system", content: fresh.map((i) => i.text).join("\n\n") });
        }
        const { msg, usage } = await chat(MODEL, messages, tools);
        r.modelCalls++;
        r.promptTokens += usage.prompt_tokens;
        r.completionTokens += usage.completion_tokens;
        r.costUsd += usage.cost ?? 0;
        messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
        if (!msg.tool_calls?.length) {
          r.answer = msg.content ?? "";
          break;
        }
        for (const call of msg.tool_calls) {
          r.toolCalls++;
          let input: { query?: string; question?: string } = {};
          try {
            input = JSON.parse(call.function.arguments || "{}");
          } catch {}
          let result = "Unknown tool.";
          if (call.function.name === "ask_context" && partner) {
            const a = await partner.ask({ ...scope, sessionId, question: String(input.question ?? input.query ?? "") });
            result = a.answer || "Nothing found.";
          } else {
            const source = sources.find((s) => `search_${s.id}` === call.function.name);
            if (source) {
              // A connector failure (the realistic profiles fail some calls) goes back to the agent as a tool error,
              // as a tool runtime would return it.
              const items = await source
                .search(
                  { scope, text: String(input.query ?? input.question ?? ""), entities: [], limit: TOOL_ITEMS },
                  AbortSignal.timeout(10_000),
                )
                .catch((e: unknown) => `Error: ${e instanceof Error ? e.message : String(e)}`);
              result = typeof items === "string" ? items : render(items);
              // Eden sees what the agent fetched, so it does not deliver it again.
              if (partner) await partner.observe(ev({ kind: "tool_result", tool: call.function.name, output: result }));
            }
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        if (step === MAX_STEPS - 1) r.answer = msg.content ?? "";
      }
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
    }
    r.wallMs = performance.now() - t0;
    r.leaked = task.secrets.some((s) => r.answer.includes(s));
    out.push(r);
    previous = { sessionId, r };
    // Over budget: this stream stops, and what it finished is kept.
    if (spent >= BUDGET) break;
  }
  await closePrevious();
  return out;
}

/** The grader's verdict (ab-common.ts): which needed facts the answer states. */
const grade = async (task: Task, answer: string) => (await gradeVia(KEY!, meter, GRADER, task, answer)).facts;

// Hidden-context suites run each world twice: with the hidden item planted, and with its decoy (`--variants`).
const VARIANTS = opt("variants", "hidden").split(",") as ("hidden" | "control")[];
// Several suites: each is planted in its own copy of the world, so their items never share a slot.
const worlds = SEEDS.flatMap((seed) =>
  SUITE_LIST.flatMap((suite) =>
    (LOOKUPS ? ["hidden" as const] : VARIANTS).map((variant) => worldOf(seed, suite, variant)),
  ),
);
/** One world for one seed, suite and variant, with its tasks (ab-common.ts). */
function worldOf(seed: number, suite: string, variant: "hidden" | "control") {
  return worldVia(seed, suite, variant, { maxTasks: MAX_TASKS, maxOffworld: OFFWORLD });
}
console.error(
  `${worlds.reduce((n, w) => n + w.tasks.length, 0)} tasks × ${CONDITIONS.length} conditions, model ${MODEL}, ` +
    `grader ${GRADER}, budget $${BUDGET}, suites ${SUITE_LIST.join(",")}`,
);
if (DRY) {
  const count = new Map<string, number>();
  for (const t of worlds.flatMap((w) => w.tasks))
    count.set(`${t.suite}/${t.kind}`, (count.get(`${t.suite}/${t.kind}`) ?? 0) + 1);
  for (const [k, n] of count) console.error(`  ${k}: ${n}`);
  process.exit(0);
}
const MERGE = opt("merge", "");
const earlier = MERGE
  ? (JSON.parse(readFileSync(MERGE, "utf8")) as { results: RunResult[] }).results.filter(
      (r) => !CONDITIONS.includes(r.condition),
    )
  : [];
const results: RunResult[] = [...earlier];
const byId = new Map(worlds.flatMap((w) => w.tasks).map((t) => [t.id, t]));
try {
  const streams = worlds.flatMap((w) => CONDITIONS.map((c) => runWorld(w.world, w.seed, w.tasks, c)));
  for (const r of await Promise.all(streams)) results.push(...r);
} catch (e) {
  console.error(`stopped: ${e instanceof Error ? e.message : e}`);
}
// Grading: each result once; a failed grading call leaves that result ungraded (reported), never scored as a miss.
const queue = results.filter((r) => !r.error && !r.facts && byId.has(r.task));
let ungraded = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try {
        r.facts = await grade(byId.get(r.task)!, r.answer);
      } catch (e) {
        ungraded++;
        if (e instanceof OverBudget) queue.length = 0;
      }
    }
  }),
);
const tasks = worlds.flatMap((w) => w.tasks);
writeFileSync(
  OUT,
  JSON.stringify({ model: MODEL, grader: GRADER, seeds: SEEDS, suites: SUITE_LIST, spent, tasks, results }, null, 2),
);
console.error(`spent $${spent.toFixed(4)}; ${results.length} runs, ${ungraded} left ungraded → ${OUT}`);
