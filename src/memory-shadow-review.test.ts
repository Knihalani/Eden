/**
 * P1.3 review round 1's probes, kept as regression tests.
 *
 * Claude Code 2.1.294 (its binary: `defaultPath`, `resolveEntry`) keeps auto memory at
 * `<config>/projects/<sanitized canonical git root>/memory/MEMORY.md`, where the canonical root of a git worktree is
 * its main repository, and `<sanitized>` replaces every non-alphanumeric character with "-". Transcripts sit under
 * `<config>/projects/<sanitized original cwd>/`. The two differ for a session in a worktree or in a repo's subfolder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isResidualNote, residualSentences, unsaidText } from "./memory-residual";
import { shadowTexts } from "./memory-shadow";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "eden-shadow-review-")));
  dirs.push(dir);
  return dir;
}

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const sanitized = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
}

describe("D27: auto-memory MEMORY.md where Claude Code keeps it", () => {
  test("a session in a git worktree: MEMORY.md under the main repository's project folder counts", () => {
    const root = temp();
    const main = join(root, "repo");
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(root, "repo-wt");
    git(main, "worktree", "add", "-q", "--detach", worktree);
    const projects = join(root, "claude", "projects");
    const transcriptPath = join(projects, sanitized(worktree), "s1.jsonl");
    write(join(projects, sanitized(main), "memory", "MEMORY.md"), "- The database is postgres.\n");
    expect(shadowTexts(undefined, { cwd: worktree, transcriptPath })).toEqual(["- The database is postgres.\n"]);
  });

  test("a session in a repo's subfolder: MEMORY.md under the repo top's project folder counts", () => {
    const root = temp();
    const top = join(root, "repo");
    const cwd = join(top, "apps", "web");
    mkdirSync(cwd, { recursive: true });
    git(top, "init", "-q");
    const projects = join(root, "claude", "projects");
    const transcriptPath = join(projects, sanitized(cwd), "s1.jsonl");
    write(join(projects, sanitized(top), "memory", "MEMORY.md"), "- The database is postgres.\n");
    expect(shadowTexts(undefined, { cwd, transcriptPath })).toEqual(["- The database is postgres.\n"]);
  });
});

describe("D26/D7: what asserts a value", () => {
  const fact = (text: string) => ({ id: text, kind: "fact", text: `[fact · 0m] ${text}` });

  test("an instruction that opens with 'When …,' is not a question: 'When installing, use pnpm.' states pnpm", () => {
    const said = residualSentences(["When installing packages, use pnpm."]);
    expect(isResidualNote(fact("The package manager is pnpm"), said)).toBe(true);
  });

  test("a note with no text is not one the residual states", () => {
    const said = residualSentences(["The database is postgres."]);
    expect(isResidualNote({ id: "empty", text: "" }, said)).toBe(false);
    expect(unsaidText({ id: "empty", text: "" }, said)).toBe("");
  });
});

describe("D27: an instruction file that says the opposite does not state a rule", () => {
  const rule = (text: string) => ({ id: text, kind: "rule", text: `[rule · 0m] ${text}` });

  test("'Do not run the migrations on staging' does not state 'Run the migrations on staging'", () => {
    const said = residualSentences(["Do not run the migrations on staging."]);
    const note = rule("Run the migrations on staging.");
    expect(unsaidText(note, said)).toBe(note.text);
  });

  test("'Never force-push to main' does not state 'Always force-push to main'", () => {
    const said = residualSentences(["Never force-push to main."]);
    const note = rule("Always force-push to main.");
    expect(unsaidText(note, said)).toBe(note.text);
  });
});

describe("D27: AGENTS.md names Claude Code reads (2.1.294: AGENTS.md and .claude/AGENTS.md)", () => {
  test("a project with no CLAUDE.md: its .claude/AGENTS.md counts", () => {
    const top = temp();
    write(join(top, ".claude", "AGENTS.md"), "The database is postgres.\n");
    expect(shadowTexts(undefined, { cwd: top })).toEqual(["The database is postgres.\n"]);
  });
});
