/**
 * P1.3 review round 2's probe, kept as a regression test.
 * One unreadable part of the shadow set (the auto-memory folder lookup) must not empty the whole set: the loaded
 * CLAUDE.md still counts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recordInstructions, shadowSentences } from "./memory-shadow";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "eden-shadow-review2-")));
  dirs.push(dir);
  return dir;
}

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe("D27: the shadow set fails open part by part", () => {
  test("a long project path whose projects folder is missing still keeps the loaded CLAUDE.md", () => {
    const win = temp();
    const deep = join(temp(), "a".repeat(120), "b".repeat(100));
    mkdirSync(deep, { recursive: true });
    const claude = write(join(deep, "CLAUDE.md"), "The database is postgres.\n");
    recordInstructions(win, { file_path: claude, load_reason: "session_start" });
    const transcriptPath = join(temp(), "missing-projects", "session-folder", "s1.jsonl");
    expect(shadowSentences(win, { cwd: deep, transcriptPath }).length).toBe(1);
  });
});
