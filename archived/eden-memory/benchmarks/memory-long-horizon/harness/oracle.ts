/**
 * The world oracle (A5 §3.4): the true value of every slot and policy over a run, including repo changes the
 * user never mentions. The scenario owns the truth. A step says which values it changes, and the oracle
 * records each change at the event-log position from which it holds. Nothing here reads what a hook printed.
 *
 * Truth on the current branch: a value the user stated in a prompt that a rewind abandoned no longer holds
 * (A4 §3.3 moves such rows to history), so the oracle takes it back.
 */
import { writeFileSync } from "node:fs";

export type SubjectKind = "slot" | "policy";

/** Something the world holds a value for (a D7 slot or a D9 policy), and the phrases that state it in text. */
export interface Subject {
  /** A slot name (`auth.provider`) or a policy key (`policy:commit|neg|.env`). */
  key: string;
  kind: SubjectKind;
  /** Phrases that name the subject; a statement of a value needs one of them in the same sentence… */
  words: readonly string[];
  /** …unless the value is one of these, which name the subject on their own (`pnpm` is a package manager). */
  standalone?: readonly string[];
  /** Every value the scenario uses, each with the phrases that state it. */
  values: Readonly<Record<string, readonly string[]>>;
}

/** A change to the truth. `value: null`: the item no longer holds (retracted, revoked, removed). */
export interface Effect {
  key: string;
  /** The scope the value is defined at: `""` is the repo root. */
  scope: string;
  value: string | null;
}

export type Cause = "init" | "user" | "repo" | "rewind";

export interface OracleEntry extends Effect {
  /** The event-log position from which the value holds: an event with this `seq` or a later one sees it. */
  seq: number;
  /** Simulated time, epoch ms. */
  t: number;
  cause: Cause;
  /** The transcript uuid of the prompt that stated it, for a user effect: a rewind past it takes it back. */
  origin?: string;
}

/** The value an item has at a moment, and the scope that defines it (it may be an ancestor's). */
export interface Truth {
  scope: string;
  value: string | null;
}

/** `key@scope`: how annotated cues name an item (`pkg.manager@`, `auth.provider@apps/web`). */
export function itemId(key: string, scope: string): string {
  return `${key}@${scope}`;
}

export function parseItemId(id: string): { key: string; scope: string } {
  const at = id.lastIndexOf("@");
  if (at <= 0) throw new Error(`item id "${id}" is not key@scope`);
  return { key: id.slice(0, at), scope: id.slice(at + 1) };
}

/** A scope and its ancestors, nearest first: `apps/web` → `apps/web`, `apps`, `""`. */
export function scopeChain(scope: string): string[] {
  const parts = scope ? scope.split("/") : [];
  const chain: string[] = [];
  for (let n = parts.length; n > 0; n--) chain.push(parts.slice(0, n).join("/"));
  chain.push("");
  return chain;
}

interface Assertion {
  value: string | null;
  origin?: string;
}

export class Oracle {
  /** Every change, in the order it happened: the content of `oracle.jsonl`. */
  readonly entries: OracleEntry[] = [];
  /** Per item, the assertions still standing, oldest first; the newest one is the item's value. */
  private readonly standing = new Map<string, Assertion[]>();

  constructor(readonly subjects: readonly Subject[]) {
    const keys = new Set<string>();
    for (const subject of subjects) {
      if (keys.has(subject.key)) throw new Error(`subject ${subject.key} is defined twice`);
      keys.add(subject.key);
    }
  }

  subject(key: string): Subject {
    const subject = this.subjects.find((candidate) => candidate.key === key);
    if (!subject) throw new Error(`no subject ${key} in the world`);
    return subject;
  }

  apply(effects: readonly Effect[], cause: Exclude<Cause, "rewind">, at: { seq: number; t: number }, origin?: string) {
    for (const effect of effects) {
      const subject = this.subject(effect.key);
      if (effect.value !== null && !(effect.value in subject.values)) {
        throw new Error(`${effect.value} is not a value of ${effect.key}`);
      }
      const id = itemId(effect.key, effect.scope);
      this.standing.set(id, [...(this.standing.get(id) ?? []), { value: effect.value, origin }]);
      this.entries.push({ ...effect, seq: at.seq, t: at.t, cause, ...(origin === undefined ? {} : { origin }) });
    }
  }

  /** A rewind abandoned the prompts with these origins: what they stated no longer holds. */
  abandon(origins: ReadonlySet<string>, at: { seq: number; t: number }): void {
    for (const [id, assertions] of this.standing) {
      const kept = assertions.filter((assertion) => assertion.origin === undefined || !origins.has(assertion.origin));
      if (kept.length === assertions.length) continue;
      this.standing.set(id, kept);
      const { key, scope } = parseItemId(id);
      this.entries.push({ key, scope, value: kept.at(-1)?.value ?? null, seq: at.seq, t: at.t, cause: "rewind" });
    }
  }

  /**
   * The value of `key` seen from `scope` at event `seq`: the nearest ancestor-or-self scope with a live value
   * (a value set at `apps/web` overrides the root's; removing it uncovers the root's again). `value: null` when
   * the item was defined somewhere on the chain but holds nowhere; undefined when it was never defined.
   */
  truth(key: string, scope: string, seq: number): Truth | undefined {
    let removed: Truth | undefined;
    for (const candidate of scopeChain(scope)) {
      const entry = this.latest(key, candidate, seq);
      if (!entry) continue;
      if (entry.value !== null) return { scope: candidate, value: entry.value };
      removed ??= { scope: candidate, value: null };
    }
    return removed;
  }

  /**
   * The values `key` holds at `scope` and below it, each at the scope that sets it: where an unscoped
   * statement in a turn at `scope` can be true when `scope` itself holds no value.
   */
  within(key: string, scope: string, seq: number): Truth[] {
    const scopes = new Set(this.entries.filter((entry) => entry.key === key).map((entry) => entry.scope));
    const below = [...scopes].filter((candidate) => !scope || candidate === scope || candidate.startsWith(`${scope}/`));
    return below.flatMap((candidate) => {
      const value = this.latest(key, candidate, seq)?.value;
      return value ? [{ scope: candidate, value }] : [];
    });
  }

  write(path: string): void {
    writeFileSync(path, this.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }

  private latest(key: string, scope: string, seq: number): OracleEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (entry.seq <= seq && entry.key === key && entry.scope === scope) return entry;
    }
    return undefined;
  }
}
