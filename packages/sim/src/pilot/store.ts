/**
 * The pilot kit's files (F3, D489): one directory on the owner's own machine, outside any git work tree, 0700 with
 * 0600 files, holding the redacted import, the owner's tasks and marks, and each run's results. Nothing else in Eden
 * writes source content to disk in the clear (D8; D425's opt-in is encrypted): the pilot does, for one consenting
 * account, on that person's own machine, and `forget` deletes all of it. Lab tooling, not product code.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Whether `dir` or a directory above it is a git work tree: real data must never sit where a commit could take it. */
export function insideGit(dir: string): boolean {
  for (let d = resolve(dir); ; d = dirname(d)) {
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

  /** Creates the directory, owner-only; an existing one is narrowed to owner-only. */
  init(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  exists(name = "."): boolean {
    return existsSync(this.path(name));
  }

  /** A file written owner-only, through a temporary file so a crash leaves the old one. */
  write(name: string, text: string): string {
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
    if (!/^[A-Za-z0-9._-]+$/.test(run) || run.startsWith(".")) throw new PilotDirError(`bad run name ${run}`);
    return join(this.dir, "runs", run);
  }

  marks(run: string): PilotMarks {
    return this.json<PilotMarks>(join("runs", run, "marks.json"), {});
  }

  saveMarks(run: string, marks: PilotMarks): void {
    this.runDir(run);
    this.write(join("runs", run, "marks.json"), JSON.stringify(marks, null, 2));
  }

  /** Every file the pilot wrote, gone. Returns whether there was anything. */
  forget(): boolean {
    if (!existsSync(this.dir)) return false;
    // Only a directory the pilot made is removed whole: one holding anything else is refused.
    const mode = statSync(this.dir).mode & 0o777;
    if (mode !== 0o700) throw new PilotDirError(`${this.dir} is not an owner-only pilot directory: not removed`);
    rmSync(this.dir, { recursive: true, force: true });
    return true;
  }
}
