#!/usr/bin/env bun
/**
 * I3 (D500–D504, docs/research/i3-push-check.md): `regrade.ts`'s Anthropic regrade sent as Message Batches, lab only.
 * The same prompt (`gradeMessages`), cap, JSON mode and request body (`anthropicBody`, Sonnet 5.5's thinking set as
 * `AnthropicModel` sets it) as `regrade.ts --graders claude-sonnet-5-5`, at the batch price (half) and in minutes
 * rather than one call at a time. Nothing in a product package imports this file.
 *
 *   bun packages/sim/src/lab/i3-regrade.ts --results A.json[,B.json…] --spend-ledger F --spend-cap USD
 *     [--model claude-sonnet-5-5] [--run-label L] [--conditions eden,eden~check] [--dry]
 *
 * It regrades every hidden answer and every control or neutral answer the run's grader called a concern (I3's
 * pre-registration), of the named arms, in one batch over all the files, and writes `regrade-sonnet.json` beside each
 * results file in `regrade.ts`'s output shape (`graded`: task, condition, grader, facts), which `bench_report.py
 * --sonnet` reads. The whole batch's worst case is reserved on the ledger before it is sent; each result is booked at
 * the batch price as it is read. `--dry` prints the count and the worst case and sends nothing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { anthropicBody, anthropicCost, anthropicPrice } from "@eden/llm";
import { gradeMessages, readVerdicts, type RunResult, type Task } from "./ab-common";
import { keyFor } from "./free";
import { isConcern } from "./regrade-kinds";
import { SpendLedger } from "./spend";

const argv = process.argv.slice(2);
const opt = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const FILES = opt("results").split(",").filter(Boolean);
if (!FILES.length) throw new Error("--results is required");
const MODEL = opt("model", "claude-sonnet-5-5");
const CONDITIONS = opt("conditions") ? new Set(opt("conditions").split(",")) : null;
// A verdict is a few tokens of JSON; regrade.ts caps at 2,000, which only inflates the batch's reserved worst case.
const MAX_TOKENS = 400;

interface Item {
  id: string;
  file: string;
  task: Task;
  r: RunResult;
}
const items: Item[] = [];
for (const file of FILES) {
  const run = JSON.parse(readFileSync(file, "utf8")) as { tasks: Task[]; results: RunResult[] };
  const byId = new Map(run.tasks.map((t) => [t.id, t]));
  for (const r of run.results) {
    const task = byId.get(r.task);
    if (!task?.must.length || r.error || !r.answer.trim()) continue;
    if (CONDITIONS && !CONDITIONS.has(r.condition)) continue;
    if (task.kind !== "hidden" && !isConcern(task.kind, r.facts)) continue;
    items.push({ id: `r${items.length}`, file, task, r });
  }
}
const bodyOf = (it: Item) => {
  const messages = gradeMessages(it.task, it.r.answer).map((m) => ({
    role: m.role as "system" | "user" | "assistant",
    content: String(m.content ?? ""),
  }));
  const { model: _m, ...params } = anthropicBody(
    { apiKey: "", model: MODEL },
    { messages, maxTokens: MAX_TOKENS, json: true },
    false,
  );
  return { model: MODEL, ...params };
};
const price = anthropicPrice(MODEL);
const half = { ...price, input: price.input / 2, output: price.output / 2 };
// Worst case at the batch price: the prompt at 3 characters a token, every output token used.
const worst = items.reduce((n, it) => {
  const chars = JSON.stringify(bodyOf(it).messages).length + JSON.stringify(bodyOf(it).system ?? "").length;
  return n + ((chars / 3) * half.input + MAX_TOKENS * half.output) / 1e6;
}, 0);
const kinds = (k: string) => items.filter((it) => it.task.kind === k).length;
console.log(
  `i3 regrade: ${items.length} answers (hidden ${kinds("hidden")}, control concerns ${kinds("control")}, ` +
    `neutral concerns ${kinds("neutral")}) over ${FILES.length} files, ${MODEL}; worst case $${worst.toFixed(3)}`,
);
if (argv.includes("--dry") || items.length === 0) process.exit(0);

const ledger = new SpendLedger(opt("spend-ledger"), Number(opt("spend-cap")), opt("run-label", "i3-regrade"), 0.1);
const key = keyFor(MODEL);
const headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
const base = "https://api.anthropic.com/v1/messages/batches";
const stateFile = join(dirname(FILES[0]!), `i3-regrade-${opt("run-label", "batch")}.state.json`);
let id = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as { id: string }).id : "";
if (!id) {
  ledger.meter("i3.regrade").reserve(worst);
  const requests = items.map((it) => ({ custom_id: it.id, params: bodyOf(it) }));
  const res = await fetch(base, { method: "POST", headers, body: JSON.stringify({ requests }) });
  if (!res.ok) throw new Error(`batch create ${res.status}: ${(await res.text()).slice(0, 300)}`);
  id = ((await res.json()) as { id: string }).id;
  writeFileSync(stateFile, JSON.stringify({ id, worst }));
  console.log(`i3 batch ${id}: ${items.length} requests, worst case $${worst.toFixed(3)} reserved`);
}
const byCustom = new Map(items.map((it) => [it.id, it]));
interface Graded {
  task: string;
  condition: string;
  grader: string;
  facts?: Record<string, boolean>;
  readable?: boolean;
  error?: string;
  usd?: number;
}
for (;;) {
  const s = (await (await fetch(`${base}/${id}`, { headers })).json()) as {
    processing_status: string;
    request_counts: Record<string, number>;
    results_url?: string;
  };
  console.log(`batch ${id}: ${s.processing_status} ${JSON.stringify(s.request_counts)}`);
  if (s.processing_status === "ended" && s.results_url) {
    const text = await (await fetch(s.results_url, { headers })).text();
    const graded = new Map<string, Graded[]>();
    let usd = 0;
    for (const line of text.split("\n").filter((l) => l.trim())) {
      const r = JSON.parse(line) as {
        custom_id: string;
        result: {
          type: string;
          message?: { content: { type: string; text?: string }[]; usage: Record<string, number> };
        };
      };
      const it = byCustom.get(r.custom_id);
      if (!it) continue;
      const g: Graded = { task: it.r.task, condition: it.r.condition, grader: MODEL };
      if (r.result.type !== "succeeded" || !r.result.message) {
        g.error = r.result.type;
      } else {
        const u = r.result.message.usage;
        const usage = {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          cachedInputTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
        };
        const costUsd = anthropicCost(usage, half);
        usd += costUsd;
        g.usd = costUsd;
        ledger.write("i3.regrade.batch", {
          model: MODEL,
          usage,
          costUsd,
          latencyMs: 0,
          ttftMs: null,
          stopReason: "batch",
        });
        const reply = r.result.message.content.find((c) => c.type === "text")?.text ?? "";
        const verdicts = readVerdicts(reply);
        g.facts = Object.fromEntries(it.task.must.map((f, i) => [f.id, verdicts.get(String(i + 1)) === true]));
        g.readable = it.task.must.every((_, i) => verdicts.has(String(i + 1)));
        if (!g.readable) g.error = "unreadable";
      }
      const list = graded.get(it.file) ?? [];
      graded.set(it.file, list);
      list.push(g);
    }
    for (const [file, list] of graded) {
      writeFileSync(
        join(dirname(file), "regrade-sonnet.json"),
        JSON.stringify({ results: file, graded: list }, null, 1),
      );
    }
    const failed = [...graded.values()].flat().filter((g) => g.error).length;
    console.log(
      `i3 batch ${id}: $${usd.toFixed(4)} booked, ${failed} failed; ledger total $${ledger.committedUsd.toFixed(4)}`,
    );
    break;
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
