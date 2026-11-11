/**
 * Resumable lab runs (R4, D813; lab only): a paid run appends each finished unit of work (pi-ab: a task, or a whole
 * day under `--day`/`--days`; days-calls: a user) to a journal as one JSON line, flushed as it lands, and a run
 * restarted with `--resume` on the same output path reads it back, skips those units (no model call, nothing booked
 * to the spend ledger again) and merges them into its results as if they had just run.
 *
 * The journal is `<out>.partial.jsonl` (`partialPath`). Its first line is a header holding the run's key: a hash of
 * everything that decides what a unit computes (the harness's own fields: models, prompts hash, configuration,
 * conditions, seeds, tasks, flags; and the code: `codeVersion`). A restart whose key differs is refused, naming the
 * fields that changed, so a changed configuration never reuses results. A line cut short by a kill (no newline at
 * the end of the file) is dropped on open and its unit runs again. Without `--resume` an existing journal is refused
 * too, so a forgotten flag cannot overwrite paid results; with `--resume` and no journal the run starts fresh.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";

/** The journal beside a results file: `pi-ab.json` → `pi-ab.partial.jsonl`. */
export const partialPath = (out: string) => `${out.replace(/\.json$/, "")}.partial.jsonl`;

/** A refused start (key mismatch, a journal without `--resume`): the CLIs print the message and exit 2. */
export class JournalRefused extends Error {
  override name = "JournalRefused";
}

const stable = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(stable)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x as object)
            .sort()
            .map((k) => [k, stable((x as Record<string, unknown>)[k])]),
        )
      : x;

/** A short hash of any JSON value, independent of key order. */
export const hashOf = (x: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stable(x)) ?? "null")
    .digest("hex")
    .slice(0, 16);

/**
 * The code a unit ran on: the tree of `packages/` and the lockfile at HEAD plus any uncommitted change to them (a
 * commit that touches only docs keeps the key). In a Modal shard (no `.git`), `EDEN_COMMIT_SHA`. Unknown when neither
 * is readable: such runs still resume, keyed on their other fields.
 */
export function codeVersion(cwd = process.cwd()): string {
  const git = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  const tree = git("rev-parse", "HEAD:packages", "HEAD:bun.lock");
  if (tree === null) return process.env.EDEN_COMMIT_SHA || "unknown";
  const diff = git("diff", "HEAD", "--", "packages", "bun.lock") ?? "";
  return hashOf({ tree: tree.trim(), diff });
}

/**
 * Flag/value pairs of an argv with `drop` left out, sorted: the command's own part of a key, so the order flags were
 * typed in does not matter and the flags that only name outputs or caps (`--out`, `--budget`, ...) can change.
 */
export function argvFields(argv: readonly string[], drop: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const valued = a.startsWith("--") && i + 1 < argv.length && !argv[i + 1]!.startsWith("--");
    if (drop.includes(a)) {
      if (valued) i++;
      continue;
    }
    out.push(valued ? `${a} ${argv[++i]}` : a);
  }
  return out.sort();
}

/**
 * The contents of every file an argv names (a flag's value that is an existing file, `drop` left out), hashed: a
 * cards file, intent requests, a source profile or a world bundle edited in place changes the key. Directories (a
 * replay cache, which grows as runs append to it) are not inputs here.
 */
export function argvFiles(argv: readonly string[], drop: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i - 1]!;
    if (!flag.startsWith("--") || drop.includes(flag)) continue;
    for (const path of argv[i]!.split(",")) {
      if (!path || !existsSync(path) || !statSync(path).isFile()) continue;
      out[`${flag} ${path}`] = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
    }
  }
  return out;
}

interface Header {
  journal: 1;
  key: string;
  fields: Record<string, unknown>;
}

interface Line<T> {
  unit: string;
  data: T;
}

export class RunJournal<T> {
  /** Units read back from an earlier attempt, by id. */
  readonly done = new Map<string, T>();
  /** Lines dropped on open: cut short by a kill, or not JSON. */
  torn = 0;
  /** Units this attempt wrote. */
  written = 0;

  private constructor(
    readonly path: string,
    readonly key: string,
  ) {}

  /**
   * Opens the journal at `path` for a run whose key fields are `fields`. With `resume`, an existing journal of the
   * same key is read back; a different key, or an existing journal without `resume`, throws `JournalRefused`.
   */
  static open<T>(path: string, fields: Record<string, unknown>, resume: boolean): RunJournal<T> {
    const key = hashOf(fields);
    const j = new RunJournal<T>(path, key);
    if (existsSync(path)) {
      // A kill mid-write leaves the last line without its newline: it is cut off (below, once the journal is
      // accepted), so the next append starts clean.
      const whole = readFileSync(path, "utf8");
      const end = whole.lastIndexOf("\n") + 1;
      const text = whole.slice(0, end);
      if (end < whole.length) j.torn++;
      const lines = text.split("\n").filter((l) => l.trim());
      const header = parse<Header>(lines[0]);
      if (header?.journal === 1 && typeof header.key === "string") {
        if (!resume) {
          throw new JournalRefused(
            `${path} holds ${lines.length - 1} finished units of an earlier attempt: pass --resume to reuse them ` +
              "(nothing is paid twice), or delete it to start over",
          );
        }
        if (header.key !== key) {
          const changed = Object.keys({ ...header.fields, ...fields })
            .filter((k) => hashOf(header.fields?.[k]) !== hashOf(fields[k]))
            .sort();
          throw new JournalRefused(
            `${path} was written by a different run (key ${header.key}, this run ${key}; changed: ` +
              `${changed.join(", ") || "unknown"}): its results cannot stand for this configuration. Run with the ` +
              "earlier settings, or delete the journal (or pick another --out) to start over",
          );
        }
        if (end < whole.length) truncateSync(path, Buffer.byteLength(text));
        for (const raw of lines.slice(1)) {
          const line = parse<Line<T>>(raw);
          if (line && typeof line.unit === "string" && line.data !== undefined) j.done.set(line.unit, line.data);
          else j.torn++;
        }
        return j;
      }
      // No readable header (killed while writing it): nothing in it can be trusted, so it is started again.
      j.torn += lines.length;
    }
    writeFileSync(path, `${JSON.stringify({ journal: 1, key, fields } satisfies Header)}\n`);
    return j;
  }

  /** Appends one finished unit as one line (flushed: `appendFileSync`). */
  write(unit: string, data: T): void {
    appendFileSync(this.path, `${JSON.stringify({ unit, data } satisfies Line<T>)}\n`);
    this.written++;
  }

  /** A run that finished every unit no longer needs its journal: the results file holds it all. */
  finish(complete: boolean): void {
    if (complete) rmSync(this.path, { force: true });
  }
}

function parse<X>(line: string | undefined): X | null {
  if (!line) return null;
  try {
    return JSON.parse(line) as X;
  } catch {
    return null;
  }
}
