/**
 * M7 (D930): the pre-screen's training rows, recorded from the funnel (`--prescreen-dump F`, with `--check`). Each row
 * is one check call as the engine made it: the request, the day and the pool's items exactly as the check read them
 * (`PrescreenInput`, through the partner's own `prescreen` hook, which abstains here), the gate's constraint flags,
 * the check's answer (null: unreadable or failed, fail open) and the task's labels (suite, seed, variant, template,
 * the planted item's id). Sim data only.
 */
import { appendFileSync } from "node:fs";
import {
  checkKey,
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

/** A `PushChecker` that writes each answered check as a row. */
export class DumpingChecker extends PushChecker {
  constructor(
    deps: ConstructorParameters<typeof PushChecker>[0],
    private readonly file: string,
    private readonly screen: RecordingPrescreen,
    private readonly taskOf: (session: string) => DumpTask | undefined,
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
      })),
      yes: read.yes ? [...read.yes] : null,
      called: read.called,
    };
    appendFileSync(this.file, `${JSON.stringify(row)}\n`);
    return read;
  }
}
