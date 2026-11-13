/**
 * M7 (D932): the push check's calls as rows, recorded from the funnel (`--check-dump F`, with `--check`). Each row is
 * one check call as the engine made it: the request, the day and the pool's items exactly as the check read them,
 * each item's cached title and text (`full`, as the tagger reads it), the check's answer (null: unreadable or failed,
 * fail open), its raw reply and the task's labels (suite, seed, variant, template, the planted item's id). A dataset
 * for any student of the check (M7's pre-screen, docs/research/m7-prescreen.md; M1's checkers). Sim data only.
 */
import { appendFileSync } from "node:fs";
import type { Model } from "@eden/llm";
import { checkKey, checkMessages, PushChecker, type PushCheckInput, type PushCheckRead } from "@eden/engine";
import type { Scope } from "@eden/protocol";

/** What the funnel knows of the task a session runs. */
export interface DumpTask {
  suite: string;
  seed: number;
  variant: string;
  template: string;
  planted: string;
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
        // The last user message: the request and the pool. With a rule sheet the first is the sheet, the same for
        // every check of a user, so replies keyed by it crossed between that user's checks.
        const user = request.messages.findLast((m) => m.role === "user")?.content ?? "";
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
      items: input.items.map((it) => ({
        id: it.id,
        source: it.source,
        title: it.title,
        date: it.date,
        from: it.from,
        text: it.text,
        full: this.fullOf(it.id),
      })),
      // `pushCheckSheet` (F5): the rule sheet as read (its cards' item ids, kinds and lines), and whether pool items on
      // it were sent as pointers; the prompt is `checkMessages` of this row's input.
      ...(input.sheet?.length ? { sheet: input.sheet, ...(input.sheetRefs ? { sheetRefs: true } : {}) } : {}),
      hash: input.items.map((it) => it.hash),
      yes: read.yes ? [...read.yes] : null,
      reply: this.replies.get(checkMessages(input).findLast((m) => m.role === "user")?.content ?? "") ?? null,
      called: read.called,
    };
    appendFileSync(this.file, `${JSON.stringify(row)}\n`);
    return read;
  }
}
