/**
 * `run-journal.ts` (R4, D813): the code part of the key read from any directory of the repository, untracked files
 * included; an unknown code version refuses a resume; one process holds a journal at a time (a dead holder's lock is
 * taken over); a journal deleted under a running attempt is not appended to; spend notes carry over.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeVersion, JournalRefused, RunJournal, UNKNOWN_CODE } from "./run-journal";

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
};

/** A repository with `packages/x/a.ts` and `bun.lock` committed. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "journal-repo-"));
  mkdirSync(join(dir, "packages", "x", "sub"), { recursive: true });
  writeFileSync(join(dir, "packages", "x", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "bun.lock"), "{}\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

describe("codeVersion", () => {
  test("is the same from any directory, and changes with a tracked edit seen from a subdirectory", () => {
    const dir = repo();
    const sub = join(dir, "packages", "x", "sub");
    const before = codeVersion(dir, {});
    expect(codeVersion(sub, {})).toBe(before);
    writeFileSync(join(dir, "packages", "x", "a.ts"), "export const a = 2;\n");
    expect(codeVersion(sub, {})).not.toBe(before);
    expect(codeVersion(dir, {})).toBe(codeVersion(sub, {}));
  });

  test("changes when an untracked file under packages/ is added or edited; ignored files and docs do not count", () => {
    const dir = repo();
    const before = codeVersion(dir, {});
    writeFileSync(join(dir, "README.md"), "docs\n");
    writeFileSync(join(dir, "packages", "x", "ignored.txt"), "x\n");
    expect(codeVersion(dir, {})).toBe(before);
    writeFileSync(join(dir, "packages", "x", "new.ts"), "export const b = 1;\n");
    const added = codeVersion(dir, {});
    expect(added).not.toBe(before);
    writeFileSync(join(dir, "packages", "x", "new.ts"), "export const b = 2;\n");
    expect(codeVersion(dir, {})).not.toBe(added);
  });

  test("outside git it is EDEN_COMMIT_SHA, else unknown, and an unknown code version cannot resume", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-nogit-"));
    expect(codeVersion(dir, { EDEN_COMMIT_SHA: "abc" })).toBe("abc");
    expect(codeVersion(dir, {})).toBe(UNKNOWN_CODE);
    const path = join(dir, "j.partial.jsonl");
    expect(() => RunJournal.open(path, { code: UNKNOWN_CODE }, true)).toThrow(JournalRefused);
    // A fresh run still journals (it never reuses anything).
    RunJournal.open(path, { code: UNKNOWN_CODE }, false).finish(true);
  });
});

describe("RunJournal", () => {
  test("a journal held by a live process is refused; a dead holder's lock is taken over", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-lock-"));
    const path = join(dir, "j.partial.jsonl");
    const first = RunJournal.open<number>(path, { k: 1 }, true);
    expect(() => RunJournal.open(path, { k: 1 }, true)).toThrow(/in use by process/);
    first.write("u1", 1);
    first.close();
    // A process that has exited left its lock behind (as SIGKILL does).
    const dead = spawnSync("true");
    writeFileSync(`${path}.lock`, String(dead.pid));
    const second = RunJournal.open<number>(path, { k: 1 }, true);
    expect(second.done.get("u1")).toBe(1);
    second.finish(true);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("a journal deleted under a running attempt is not appended to", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-gone-"));
    const path = join(dir, "j.partial.jsonl");
    const j = RunJournal.open<number>(path, { k: 1 }, false);
    rmSync(path);
    expect(() => j.write("u1", 1)).toThrow(/is gone/);
    expect(existsSync(path)).toBe(false);
    j.close();
  });

  test("the last spend note is read back", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-spent-"));
    const path = join(dir, "j.partial.jsonl");
    const j = RunJournal.open<number>(path, { k: 1 }, false);
    j.noteSpent(0.25);
    j.write("u1", 1);
    j.noteSpent(0.5);
    j.close();
    const again = RunJournal.open<number>(path, { k: 1 }, true);
    expect(again.spentBefore).toBe(0.5);
    expect([...again.done.keys()]).toEqual(["u1"]);
    again.close();
  });
});
