/**
 * M7 (D930): the pre-screen's training rows, recorded from the funnel (`--prescreen-dump F`, with `--check`). Each row
 * is one check call as the engine made it: the request, the day and the pool's items exactly as the check read them
 * (`PrescreenInput`, through the partner's own `prescreen` hook, which abstains here), the gate's constraint flags,
 * the check's answer (null: unreadable or failed, fail open) and the task's labels (suite, seed, variant, template,
 * the planted item's id). Sim data only.
 */
import { appendFileSync } from "node:fs";
import type { Model } from "@eden/llm";
import {
  checkKey,
  checkMessages,
  PushChecker,
  type PrescreenInput,
  type PrescreenVerdict,
  type PushCheckInput,
  type PushCheckRead,
  type PushPrescreen,
} from "@eden/engine";
import type { Scope } from "@eden/protocol";

/** What the funnel knows of the task a session runs. */
export interface DumpTask {
  suite: string;
  seed: number;
  variant: string;
  template: string;
  planted: string;
}

/** Abstains on every pool, noting the gate's flags by check key for the checker's row. */
export class RecordingPrescreen implements PushPrescreen {
  readonly like = new Map<string, boolean[]>();
  constructor(private readonly inner: PushPrescreen | null = null) {}
  decide(input: PrescreenInput): PrescreenVerdict | null {
    const key = checkKey({ request: input.request, items: [...input.items], today: input.today });
    this.like.set(key, [...input.like]);
    while (this.like.size > 256) this.like.delete(this.like.keys().next().value as string);
    return this.inner ? this.inner.decide(input) : null;
  }
}

/** The check's model with each reply kept by its user message, so a row can carry the reply it was answered with. */
export function replyKeeping(model: Model): { model: Model; replies: Map<string, string> } {
  const replies = new Map<string, string>();
  return {
    replies,
    model: {
      id: model.id,
      chat: async (request) => {
        const res = await model.chat(request);
        const user = request.messages.find((m) => m.role === "user")?.content ?? "";
        replies.set(user, res.text);
        while (replies.size > 256) replies.delete(replies.keys().next().value as string);
        return res;
      },
    },
  };
}

/** A `PushChecker` that writes each answered check as a row. */
export class DumpingChecker extends PushChecker {
  constructor(
    deps: ConstructorParameters<typeof PushChecker>[0],
    private readonly replies: Map<string, string>,
    private readonly file: string,
    private readonly screen: RecordingPrescreen,
    private readonly taskOf: (session: string) => DumpTask | undefined,
    /** The cached item's title and text as the tagger reads them (`title\ntext`), or "" when gone. */
    private readonly fullOf: (id: string) => string = () => "",
  ) {
    super(deps);
  }

  override async check(
    scope: Scope,
    session: string,
    input: PushCheckInput,
    signal: AbortSignal,
  ): Promise<PushCheckRead> {
    const read = await super.check(scope, session, input, signal);
    const key = checkKey(input);
    const row = {
      ...(this.taskOf(session) ?? {}),
      key,
      request: input.request,
      today: input.today,
      like: this.screen.like.get(key) ?? null,
      items: input.items.map((it) => ({
        id: it.id,
        source: it.source,
        title: it.title,
        date: it.date,
        from: it.from,
        text: it.text,
        full: this.fullOf(it.id),
      })),
      yes: read.yes ? [...read.yes] : null,
      reply: this.replies.get(checkMessages(input).find((m) => m.role === "user")?.content ?? "") ?? null,
      called: read.called,
    };
    appendFileSync(this.file, `${JSON.stringify(row)}\n`);
    return read;
  }
}
