import { AsyncLocalStorage } from "node:async_hooks";
import { CHECK_MAX_ITEMS, SHEET_MAX_CARDS, type PushChecker, type PushCheckInput } from "@eden/engine";
import type { ChatRequest, ChatResponse, Model } from "@eden/llm";
import { draw } from "./reader-stub";
import type { DumpTask } from "./check-dump";

interface CheckTruth {
  task: DumpTask;
  ids: string[];
  rules: string[];
}

export class OracleCheckModel implements Model {
  readonly id = "oracle-push-check";
  readonly stats = { inputTokens: 0, outputTokens: 0 };
  private readonly context = new AsyncLocalStorage<CheckTruth>();

  constructor(
    readonly tp = 1,
    readonly fp = 0,
  ) {
    for (const [name, rate] of [
      ["TP", tp],
      ["FP", fp],
    ] as const) {
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error(`check ${name} must be in [0,1]`);
    }
  }

  run<T>(task: DumpTask | undefined, input: PushCheckInput, fn: () => T): T {
    if (!task) throw new Error("oracle check has no task labels");
    return this.context.run(
      {
        task: { ...task },
        ids: input.items.slice(0, CHECK_MAX_ITEMS).map((i) => i.id),
        rules: input.sheet?.slice(0, SHEET_MAX_CARDS).map((i) => i.id) ?? [],
      },
      fn,
    );
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const truth = this.context.getStore();
    if (!truth) throw new Error("oracle check called outside its task");
    if (request.signal?.aborted) throw request.signal.reason;
    const { task, ids, rules } = truth;
    const selected = (id: string) => {
      const relevant = task.variant === "hidden" && id === task.planted;
      const key = JSON.stringify([task.suite, task.seed, task.variant, task.template, id]);
      return draw(key) < (relevant ? this.tp : this.fp);
    };
    const link = { on: "oracle proxy", hits: "this request", act: true };
    const items = ids.flatMap((id, i) => (selected(id) ? [{ i: i + 1, ...link }] : []));
    const text = JSON.stringify({
      items,
      ...(rules.length
        ? { rules: rules.flatMap((id, r) => (!ids.includes(id) && selected(id) ? [{ r: r + 1, ...link }] : [])) }
        : {}),
    });
    const inputTokens = Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    const outputTokens = Math.ceil(text.length / 4);
    this.stats.inputTokens += inputTokens;
    this.stats.outputTokens += outputTokens;
    return {
      text,
      model: this.id,
      costUsd: 0,
      latencyMs: 0,
      usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
    };
  }
}

export function taskScopedCheck(
  checker: PushChecker,
  model: OracleCheckModel,
  taskOf: (session: string) => DumpTask | undefined,
): void {
  const check = checker.check.bind(checker);
  checker.check = (scope, session, input, signal) =>
    model.run(taskOf(session), input, () => check(scope, session, input, signal));
}
