/**
 * The pilot kit's files (F3, D489): one directory on the owner's own machine, outside any git work tree, 0700 with
 * 0600 files, holding the redacted import, the owner's tasks and marks, and each run's results. Nothing else in Eden
 * writes source content to disk in the clear (D8; D425's opt-in is encrypted): the pilot does, for one consenting
 * account, on that person's own machine, and `forget` deletes all of it. Lab tooling, not product code.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { edenHome } from "@eden/protocol";

/** An item as the import keeps it: every text already through `sanitizeForStore`. */
export interface PilotItem {
  /** One of the lab's connector ids (`gmail`, `calendar`, `drive`): the profile the item is served with. */
  sourceId: string;
  ref: string;
  title: string;
  text: string;
  url?: string;
  updatedAt: number;
  meta?: Record<string, string>;
}

export interface PilotMeta {
  /** The account's owner, as the agent's system prompt names them. */
  user: { name: string; email: string };
  importedAt: number;
  /** Source id → what it holds. */
  sources: Record<string, string>;
  /** Per source: items kept, and how many had a secret redacted. */
  counts: Record<string, { items: number; redacted: number }>;
}

/** A real request of the owner's, and what mattered for it: written by the owner before any run. */
export interface PilotTask {
  id: string;
  text: string;
  /** Facts in the owner's sources an assistant should have raised; empty when nothing should change the answer. */
  facts: { id: string; detail: string }[];
  addedAt: number;
}

/** The owner's marks on one answer, made without knowing its arm. */
export interface PilotMark {
  /** Fact id → the answer raised it. */
  facts: Record<string, boolean>;
  /** The answer raised something wrong, irrelevant or misleading. */
  wrong: boolean;
}
/** task id → arm → mark. */
export type PilotMarks = Record<string, Record<string, PilotMark>>;

export class PilotDirError extends Error {}

/** The file that marks a directory as the pilot's own: only a directory holding it is written to or deleted. */
export const MARKER = ".eden-pilot";
/** Everything the pilot writes at the top of its directory: what `forget` removes, and nothing else. */
const OWNED = [MARKER, "items.jsonl", "meta.json", "tasks.json", "runs"] as const;

/** `dir` with symbolic links followed, through its nearest existing ancestor (the directory may not exist yet). */
function real(dir: string): string {
  const rest: string[] = [];
  let d = resolve(dir);
  while (!existsSync(d) && dirname(d) !== d) {
    rest.unshift(d.slice(dirname(d).length + 1));
    d = dirname(d);
  }
  return join(realpathSync(d), ...rest);
}

/**
 * Whether `dir` or a directory above it is a git work tree: real data must never sit where a commit could take it.
 * Links are followed first, so a link from outside a repository into one is refused too.
 */
export function insideGit(dir: string): boolean {
  for (let d = real(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

export function pilotDir(env: Record<string, string | undefined> = process.env): string {
  // `edenHome` reads the process environment (EDEN_HOME, else ~/.eden).
  return resolve(env.EDEN_PILOT_DIR || join(edenHome(), "pilot"));
}

export class PilotStore {
  constructor(readonly dir: string) {
    if (insideGit(dir)) {
      throw new PilotDirError(`${dir} is inside a git repository: set EDEN_PILOT_DIR to a directory outside any`);
    }
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  /**
   * Whether the directory is the pilot's: it holds the marker, or (a directory from before the marker existed) it
   * holds pilot data and nothing that is not the pilot's own.
   */
  private owned(): boolean {
    if (existsSync(this.path(MARKER))) return true;
    if (!existsSync(this.dir) || !statSync(this.dir).isDirectory()) return false;
    const names = readdirSync(this.dir);
    const mine = (n: string) => (OWNED as readonly string[]).some((o) => n === o || n === `${o}.tmp`);
    return names.length > 0 && names.every(mine);
  }

  /**
   * Creates the directory, owner-only, and marks it as the pilot's. An existing directory is taken only if it is
   * empty or already marked: the pilot never narrows, writes into or later deletes a directory with someone else's
   * files in it (`EDEN_PILOT_DIR` pointed at a home or a documents folder by mistake).
   */
  init(): void {
    if (existsSync(this.dir) && !statSync(this.dir).isDirectory()) {
      throw new PilotDirError(`${this.dir} is a file: point EDEN_PILOT_DIR at a directory`);
    }
    if (existsSync(this.dir) && !this.owned() && readdirSync(this.dir).length > 0) {
      throw new PilotDirError(`${this.dir} holds other files: point EDEN_PILOT_DIR at an empty or new directory`);
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    if (!existsSync(this.path(MARKER))) {
      writeFileSync(this.path(MARKER), "Eden pilot kit data (docs/PILOT.md).\n", { mode: 0o600 });
    }
  }

  exists(name = "."): boolean {
    return existsSync(this.path(name));
  }

  /** A file written owner-only, through a temporary file so a crash leaves the old one. */
  write(name: string, text: string): string {
    this.init();
    const p = this.path(name);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, p);
    return p;
  }

  read(name: string): string {
    return readFileSync(this.path(name), "utf8");
  }

  json<T>(name: string, fallback: T): T {
    return this.exists(name) ? (JSON.parse(this.read(name)) as T) : fallback;
  }

  saveImport(meta: PilotMeta, items: readonly PilotItem[]): void {
    this.init();
    this.write("items.jsonl", items.map((i) => `${JSON.stringify(i)}\n`).join(""));
    this.write("meta.json", JSON.stringify(meta, null, 2));
  }

  items(): PilotItem[] {
    if (!this.exists("items.jsonl")) return [];
    return this.read("items.jsonl")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as PilotItem);
  }

  meta(): PilotMeta | null {
    return this.json<PilotMeta | null>("meta.json", null);
  }

  tasks(): PilotTask[] {
    return this.json<PilotTask[]>("tasks.json", []);
  }

  saveTasks(tasks: readonly PilotTask[]): void {
    this.init();
    this.write("tasks.json", JSON.stringify(tasks, null, 2));
  }

  runDir(run: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(run) || run.startsWith(".")) {
      throw new PilotDirError("a run name is letters, digits, dots, dashes and underscores, not starting with a dot");
    }
    return join(this.dir, "runs", run);
  }

  /** A file of one run, by its name inside the pilot directory; the run's name is checked first. */
  runFile(run: string, name: string): string {
    this.runDir(run);
    return join("runs", run, name);
  }

  marks(run: string): PilotMarks {
    return this.json<PilotMarks>(this.runFile(run, "marks.json"), {});
  }

  saveMarks(run: string, marks: PilotMarks): void {
    this.write(this.runFile(run, "marks.json"), JSON.stringify(marks, null, 2));
  }

  /**
   * Everything under a run made owner-only (0700 directories, 0600 files): the harness writes its results, timeline,
   * ledger and cards with the process's default mode.
   */
  lockRun(run: string): void {
    const walk = (p: string) => {
      // A link is left as it is and never followed: what it points at is not the run's.
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return;
      const dir = st.isDirectory();
      chmodSync(p, dir ? 0o700 : 0o600);
      if (dir) for (const name of readdirSync(p)) walk(join(p, name));
    };
    const dir = this.runDir(run);
    if (existsSync(dir)) walk(dir);
  }

  /**
   * Every file the pilot wrote, gone; returns whether there was anything. Only a directory the pilot marked is
   * touched, and only the pilot's own entries in it are removed: anything else found there stays, and so does the
   * directory.
   */
  forget(): boolean {
    if (!existsSync(this.dir)) return false;
    if (!this.owned())
      throw new PilotDirError(`${this.dir} was not made by the pilot (no ${MARKER} in it): not removed`);
    for (const name of [...OWNED].reverse()) {
      rmSync(this.path(name), { recursive: true, force: true });
      // A write that a crash interrupted left the pilot's own temporary file; no other `.tmp` is the pilot's.
      rmSync(this.path(`${name}.tmp`), { force: true });
    }
    // The directory goes too when nothing else is in it (its real path: EDEN_PILOT_DIR may be a link, which stays).
    const dir = realpathSync(this.dir);
    if (readdirSync(dir).length === 0) rmdirSync(dir);
    return true;
  }
}
