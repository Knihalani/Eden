/**
 * Resumable lab runs (R4, D813; lab only): a paid run appends each finished unit of work (pi-ab: a task, or a whole
 * day under `--day`/`--days`; days-calls: a user) to a journal as one JSON line, flushed and fsynced as it lands, and
 * a run restarted with `--resume` on the same output path reads it back, skips those units (no model call, nothing
 * booked to the spend ledger again) and merges them into its results.
 *
 * The journal is `<out>.partial.jsonl` (`partialPath`). Its first line is a header holding the run's key: a hash of
 * everything that decides what a unit computes (the harness's own fields: models, prompts hash, configuration,
 * conditions, seeds, tasks, flags, the env that changes results; and the code: `codeVersion`). A restart whose key
 * differs is refused, naming the fields that changed, so a changed configuration never reuses results; so is a
 * resume whose code cannot be read. A line cut short by a kill (no newline at the end of the file) is dropped on
 * open and its unit runs again. Without `--resume` an existing journal is refused too, so a forgotten flag cannot
 * overwrite paid results; with `--resume` and no journal the run starts fresh. One process holds a journal at a time
 * (`<journal>.lock` with its pid; a dead holder's lock is taken over). Lines of `{spent}` carry what the attempts
 * have spent so far (`spentBefore`), so a resumed run's budget counts money that bought no finished unit.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** The journal beside a results file: `pi-ab.json` → `pi-ab.partial.jsonl`. */
export const partialPath = (out: string) => `${out.replace(/\.json$/, "")}.partial.jsonl`;

/** A refused start (key mismatch, a journal without `--resume`, a held lock): the CLIs print it and exit 2. */
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

/** `codeVersion` when neither git nor `EDEN_COMMIT_SHA` says what code ran: a resume is refused. */
export const UNKNOWN_CODE = "unknown";

/**
 * The code a unit ran on: the tree of `packages/` and the lockfile at HEAD, any uncommitted change to them, and the
 * contents of untracked files under `packages/` (git's ignore rules apply), all read from the repository's top
 * whatever `cwd` is inside it (a commit that touches only docs keeps the key). In a Modal shard (no `.git`),
 * `EDEN_COMMIT_SHA`; else `UNKNOWN_CODE`.
 */
export function codeVersion(cwd = process.cwd(), env = process.env): string {
  const git = (at: string, ...a: string[]) => {
    const r = spawnSync("git", a, { cwd: at, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  const top = git(cwd, "rev-parse", "--show-toplevel")?.trim();
  const tree = top ? git(top, "rev-parse", "HEAD:packages", "HEAD:bun.lock") : null;
  if (!top || tree === null) return env.EDEN_COMMIT_SHA || UNKNOWN_CODE;
  const diff = git(top, "diff", "HEAD", "--", "packages", "bun.lock");
  const untracked = git(top, "ls-files", "-o", "--exclude-standard", "-z", "--", "packages");
  if (diff === null || untracked === null) return env.EDEN_COMMIT_SHA || UNKNOWN_CODE;
  const files = untracked
    .split("\0")
    .filter(Boolean)
    .sort()
    .map((f) => {
      const path = join(top, f);
      const body = existsSync(path) && statSync(path).isFile() ? readFileSync(path) : Buffer.alloc(0);
      return `${f} ${createHash("sha256").update(body).digest("hex")}`;
    });
  return hashOf({ tree: tree.trim(), diff, untracked: files });
}

/** Environment variables the lab's model and pricing code reads that change a unit's results or its booked cost. */
export const KEY_ENV = ["EDEN_MODEL", "EDEN_MODEL_PRICE", "EDEN_MODEL_ZDR", "OPENROUTER_BASE_URL"] as const;
export const envFields = (env = process.env) => Object.fromEntries(KEY_ENV.map((k) => [k, env[k] ?? null]));

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
 * replay cache, which grows as runs append to it) are not inputs here: a replay cache's contents are not in the key.
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but is another user's.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Takes `<journal>.lock` for this process (O_EXCL with the pid), or refuses while a live process holds it. */
function lock(path: string): string {
  const file = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const pid = Number(readFileSync(file, "utf8").trim());
    if (pid > 0 && alive(pid)) {
      throw new JournalRefused(
        `${path} is in use by process ${pid} (${file}): two attempts on one journal would pay twice; wait for it, ` +
          "or stop it",
      );
    }
    // The holder died (a kill leaves its lock): taken over.
    rmSync(file, { force: true });
  }
  throw new JournalRefused(`${file}: could not take the lock`);
}

interface Header {
  journal: 1;
  key: string;
  fields: Record<string, unknown>;
}

interface Line<T> {
  unit?: string;
  data?: T;
  /** What every attempt so far has spent, in dollars (`noteSpent`). */
  spent?: number;
}

export class RunJournal<T> {
  /** Units read back from an earlier attempt, by id. */
  readonly done = new Map<string, T>();
  /** Lines dropped on open: cut short by a kill, or not JSON. */
  torn = 0;
  /** Units this attempt wrote. */
  written = 0;
  /** The spend the earlier attempts noted last (0 for a fresh journal). */
  spentBefore = 0;
  private lockFile: string | null = null;

  private constructor(
    readonly path: string,
    readonly key: string,
  ) {}

  /**
   * Opens the journal at `path` for a run whose key fields are `fields`, holding its lock until `close`, `finish` or
   * the process's exit. With `resume`, an existing journal of the same key is read back; a different key, an
   * unknown code version (`fields.code`), an existing journal without `resume`, or a live holder throws
   * `JournalRefused`.
   */
  static open<T>(path: string, fields: Record<string, unknown>, resume: boolean): RunJournal<T> {
    const key = hashOf(fields);
    const j = new RunJournal<T>(path, key);
    j.lockFile = lock(path);
    process.once("exit", j.release);
    try {
      j.read(fields, resume);
    } catch (e) {
      j.close();
      throw e;
    }
    return j;
  }

  private read(fields: Record<string, unknown>, resume: boolean): void {
    const { path, key } = this;
    if (resume && fields.code === UNKNOWN_CODE) {
      throw new JournalRefused(
        "--resume needs to know the code a unit ran on: no git repository here and no EDEN_COMMIT_SHA",
      );
    }
    if (existsSync(path)) {
      // A kill mid-write leaves the last line without its newline: it is cut off (below, once the journal is
      // accepted), so the next append starts clean.
      const whole = readFileSync(path, "utf8");
      const end = whole.lastIndexOf("\n") + 1;
      const text = whole.slice(0, end);
      if (end < whole.length) this.torn++;
      const lines = text.split("\n").filter((l) => l.trim());
      const header = parse<Header>(lines[0]);
      if (header?.journal === 1 && typeof header.key === "string") {
        if (!resume) {
          throw new JournalRefused(
            `${path} holds finished units of an earlier attempt: pass --resume to reuse them (nothing is paid ` +
              "twice), or delete it to start over",
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
          if (line && typeof line.spent === "number") this.spentBefore = line.spent;
          else if (line && typeof line.unit === "string" && line.data !== undefined)
            this.done.set(line.unit, line.data);
          else this.torn++;
        }
        return;
      }
      // No readable header (killed while writing it): nothing in it can be trusted, so it is started again.
      this.torn += lines.length;
    }
    writeFileSync(path, `${JSON.stringify({ journal: 1, key, fields } satisfies Header)}\n`);
  }

  /** Appends one line and fsyncs it; refuses when the journal is gone (deleted under a running attempt). */
  private append(line: Line<T>): void {
    if (!existsSync(this.path)) {
      throw new JournalRefused(`${this.path} is gone: not appending a line no header can vouch for`);
    }
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, `${JSON.stringify(line)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Appends one finished unit as one line. */
  write(unit: string, data: T): void {
    this.append({ unit, data });
    this.written++;
  }

  /** Notes what every attempt so far has spent (`spentBefore` on the next resume). */
  noteSpent(usd: number): void {
    this.append({ spent: usd });
  }

  private readonly release = () => this.close();

  /** Releases the lock (the journal stays). */
  close(): void {
    process.off("exit", this.release);
    if (!this.lockFile) return;
    try {
      if (readFileSync(this.lockFile, "utf8").trim() === String(process.pid)) rmSync(this.lockFile, { force: true });
    } catch {
      // Already gone.
    }
    this.lockFile = null;
  }

  /** A run that finished every unit no longer needs its journal: the results file holds it all. */
  finish(complete: boolean): void {
    if (complete) rmSync(this.path, { force: true });
    this.close();
  }
}

/** A results file's `resumed` block (pi-ab), as the reports print it: null for a run that reused nothing. */
export function resumedNote(
  file: string,
  resumed?: { units: number; tasks: number; unitsUsd?: number; spentBeforeUsd?: number; biased?: boolean },
): string | null {
  if (!resumed?.units) return null;
  return (
    `${file}: RESUMED (D813): ${resumed.tasks} task runs in ${resumed.units} units were taken from an earlier ` +
    `attempt's journal ($${(resumed.unitsUsd ?? 0).toFixed(4)} as they ran; earlier attempts spent ` +
    `$${(resumed.spentBeforeUsd ?? 0).toFixed(4)})` +
    (resumed.biased
      ? "; BIASED (--resume-biased): Eden arms ran the later days against an Eden that never saw the reused days"
      : "")
  );
}

function parse<X>(line: string | undefined): X | null {
  if (!line) return null;
  try {
    return JSON.parse(line) as X;
  } catch {
    return null;
  }
}
