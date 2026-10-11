import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { residualSentences, unsaidText } from "./memory-residual";
import { loadedInstructions, recordInstructions, shadowTexts, startShadowEpoch } from "./memory-shadow";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-shadow-"));
  dirs.push(dir);
  return dir;
}

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const load = (file: string, reason: string, promptId?: string) => ({
  file_path: file,
  load_reason: reason,
  ...(promptId ? { prompt_id: promptId } : {}),
});

describe("D27: the window's loads", () => {
  test("an eager file reported again (every process start) is recorded once; a lazy one once per prompt", () => {
    const win = temp();
    recordInstructions(win, load("/p/CLAUDE.md", "session_start"));
    recordInstructions(win, load("/p/CLAUDE.md", "session_start"));
    recordInstructions(win, load("/p/CLAUDE.md", "compact"));
    recordInstructions(win, load("/p/web/CLAUDE.md", "nested_traversal", "p1"));
    recordInstructions(win, load("/p/web/CLAUDE.md", "nested_traversal", "p1"));
    recordInstructions(win, load("/p/web/CLAUDE.md", "nested_traversal", "p2"));
    const lines = readFileSync(join(win, "shadow.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(loadedInstructions(win)).toEqual(["/p/CLAUDE.md", "/p/web/CLAUDE.md"]);
  });

  test("an epoch drops lazy loads made before it and keeps eager ones; a later lazy load counts again", () => {
    const win = temp();
    recordInstructions(win, load("/p/CLAUDE.md", "session_start"));
    recordInstructions(win, load("/p/web/CLAUDE.md", "nested_traversal", "p1"));
    recordInstructions(win, load("/p/.claude/rules/db.md", "path_glob_match", "p1"));
    startShadowEpoch(win);
    expect(loadedInstructions(win)).toEqual(["/p/CLAUDE.md"]);
    recordInstructions(win, load("/p/web/CLAUDE.md", "nested_traversal", "p1"));
    expect(loadedInstructions(win)).toEqual(["/p/CLAUDE.md", "/p/web/CLAUDE.md"]);
  });

  test("a lazy load of a prompt a rewind abandoned is not in the window", () => {
    const win = temp();
    recordInstructions(win, load("/p/web/CLAUDE.md", "nested_traversal", "p1"));
    recordInstructions(win, load("/p/cli/CLAUDE.md", "nested_traversal", "p2"));
    const mark = { v: 1, path: "/t.jsonl", off: 0, prompts: [], lines: [], abandoned: ["p1"] };
    writeFileSync(join(win, "hwm.json"), JSON.stringify(mark));
    expect(loadedInstructions(win)).toEqual(["/p/cli/CLAUDE.md"]);
  });

  test("a payload without a file or a reason records nothing", () => {
    const win = temp();
    recordInstructions(win, { load_reason: "session_start" });
    recordInstructions(win, { file_path: "/p/CLAUDE.md" });
    expect(loadedInstructions(win)).toEqual([]);
  });
});

describe("D27: files read from disk", () => {
  test("AGENTS.md from the session's folder up to the repo's top, only where no folder has a CLAUDE.md", () => {
    const top = temp();
    const cwd = join(top, "apps", "web");
    write(join(top, "AGENTS.md"), "Root agents.");
    write(join(cwd, "AGENTS.md"), "Web agents.");
    expect(shadowTexts(undefined, { cwd, top })).toEqual(["Web agents.", "Root agents."]);
    write(join(top, ".claude", "CLAUDE.md"), "Claude file.");
    expect(shadowTexts(undefined, { cwd, top })).toEqual([]);
  });

  test("outside git only the session's folder is looked at", () => {
    const parent = temp();
    write(join(parent, "AGENTS.md"), "Parent agents.");
    write(join(parent, "here", "AGENTS.md"), "Here agents.");
    expect(shadowTexts(undefined, { cwd: join(parent, "here") })).toEqual(["Here agents."]);
  });

  test("MEMORY.md beside the transcript: its first 200 lines, as Claude Code loads it", () => {
    const projects = temp();
    const lines = Array.from({ length: 250 }, (_, at) => `- memory ${at + 1}`);
    write(join(projects, "memory", "MEMORY.md"), lines.join("\n"));
    const [index] = shadowTexts(undefined, { transcriptPath: join(projects, "s1.jsonl") });
    expect(index?.split("\n")).toHaveLength(200);
    expect(index).toContain("- memory 200");
    expect(index).not.toContain("- memory 201");
  });

  test("the loaded files are read at each delivery, so an edit counts at once; a missing file gives nothing", () => {
    const win = temp();
    const file = write(join(temp(), "CLAUDE.md"), "Old text.");
    recordInstructions(win, load(file, "session_start"));
    recordInstructions(win, load("/missing/CLAUDE.md", "session_start"));
    write(file, "New text.");
    expect(shadowTexts(win, {})).toEqual(["New text."]);
  });
});

describe("unsaidText: a note without what the window states", () => {
  const said = residualSentences(["# Project", "Use pnpm, not npm, for every install.", "Logs go to stdout."]);

  test("a gist's stated sentence is dropped, its other sentences kept under its label", () => {
    const gist = { id: "g", kind: "gist", text: "[gist · 0m] package manager is pnpm. database is postgres" };
    expect(unsaidText(gist, said)).toBe("[gist · 0m] database is postgres");
  });

  test("a note it states in full is empty; a note it does not state is returned as it is", () => {
    expect(unsaidText({ id: "e", kind: "episode", text: "Logs go to stdout." }, said)).toBe("");
    const other = { id: "f", kind: "fact", text: "The database is postgres." };
    expect(unsaidText(other, said)).toBe(other.text);
  });

  test("an episode is read by Jaccard, not the slot rule: 'we use pnpm' alone is not 'the package manager is pnpm'", () => {
    const episode = { id: "e", kind: "episode", text: "The package manager is pnpm." };
    expect(unsaidText(episode, said)).toBe(episode.text);
  });
});
