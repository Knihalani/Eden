/**
 * P1.3 at the hook (D27, R7 §13, R0 F16/F35): the window's shadow set. The instruction files InstructionsLoaded
 * reports, AGENTS.md where the project has no CLAUDE.md, and auto-memory MEMORY.md beside the transcript: what they
 * already state is never delivered, at Submit or SessionStart. A lazy load (`nested_traversal`, `path_glob_match`)
 * leaves the window's context at a compaction or `/clear`; an eager one stays.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MEMORY_HOOK_EVENTS } from "./doctor";
import { memoryHookResponse, type HookStage } from "./memory-hook";
import { installedHooks } from "./setup";
import { cuesBelowTau } from "../../../scripts/test-below-tau";

cuesBelowTau();

const SESSION = "s-shadow";
const NOW = Date.parse("2026-10-11T12:00:00Z");
const FACT = "The database is postgres.";
const FACT_CUE = "what database do we use?";

let dir = "";
let project = "";
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_FLAG_DELIVER_SUBMIT"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-shadow-"));
  project = join(dir, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q"], { cwd: project });
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  delete process.env.EDEN_MEMORY;
  delete process.env.EDEN_FLAG_DELIVER_SUBMIT;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
});

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function hook(fields: Record<string, unknown>, stage?: HookStage): Record<string, unknown> | null {
  return memoryHookResponse({ session_id: SESSION, cwd: project, ...fields }, stage);
}

function packetOf(out: Record<string, unknown> | null): string {
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
}

function submit(prompt: string, promptId: string, fields: Record<string, unknown> = {}): string {
  return packetOf(hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: promptId, ...fields }));
}

function loaded(path: string, reason: string, fields: Record<string, unknown> = {}): void {
  hook({
    hook_event_name: "InstructionsLoaded",
    file_path: path,
    memory_type: "Project",
    load_reason: reason,
    ...fields,
  });
}

function compact(fields: Record<string, unknown> = {}): void {
  hook({ hook_event_name: "SessionStart", source: "compact", ...fields });
  hook({ hook_event_name: "PostCompact", trigger: "manual", compact_summary: "The user asked about CI.", ...fields });
}

type Wide = Record<string, unknown> & { ev: string };

function lastEvent(ev: string): Wide | undefined {
  const events = join(dir, "memory", "hook.log.d");
  return readdirSync(events)
    .sort()
    .flatMap((name) => readFileSync(join(events, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Wide)
    .findLast((event) => event.ev === ev);
}

describe("D27: what a loaded instruction file states is never delivered", () => {
  test("an eager CLAUDE.md (InstructionsLoaded session_start) that states the fact: no bullet, and a drop", () => {
    loaded(write(join(project, "CLAUDE.md"), "# Project\n\nThe database is postgres.\n"), "session_start");
    submit(FACT, "p1");
    expect(submit(FACT_CUE, "p2")).not.toContain("postgres");
    expect((lastEvent("UserPromptSubmit")?.drops as Record<string, number> | undefined)?.shadow).toBe(1);
  });

  test("control: the same file on disk, never reported loaded, does not suppress the fact", () => {
    write(join(project, "CLAUDE.md"), "# Project\n\nThe database is postgres.\n");
    submit(FACT, "p1");
    expect(submit(FACT_CUE, "p2")).toContain("postgres");
  });

  test("the shadow set is per window: another session that never loaded the file still gets the fact", () => {
    loaded(write(join(project, "CLAUDE.md"), "The database is postgres.\n"), "session_start", { session_id: "other" });
    submit(FACT, "p1");
    expect(submit(FACT_CUE, "p2")).toContain("postgres");
  });

  test("'Use pnpm, not npm' states the pnpm slot (D7's bare use), never npm", () => {
    loaded(write(join(project, "CLAUDE.md"), "Use pnpm, not npm, for every install.\n"), "session_start");
    submit("The package manager is pnpm.", "p1");
    expect(submit("which package manager do we use?", "p2")).not.toContain("pnpm");
    loaded(join(project, "CLAUDE.md"), "session_start", { session_id: "s-npm" });
    submit("The package manager is npm.", "q1", { session_id: "s-npm" });
    expect(submit("which package manager do we use?", "q2", { session_id: "s-npm" })).toMatch(/\bnpm\b/);
  });

  test("a stated sentence leaves the note; the note's other sentences are still delivered", () => {
    loaded(write(join(project, "CLAUDE.md"), "The database is postgres.\n"), "session_start");
    submit("The database is postgres. The cache is ZebraCache.", "p1");
    const packet = submit("what database and cache do we use?", "p2");
    expect(packet).not.toContain("postgres");
    expect(packet).toContain("ZebraCache");
  });
});

describe("D27: lazy loads follow the window's context (captured on Claude Code 2.1.294)", () => {
  test("a nested CLAUDE.md suppresses after its Read loads it, and no longer once a compaction drops it", () => {
    const nested = write(join(project, "apps", "web", "CLAUDE.md"), "The database is postgres.\n");
    submit(FACT, "p1");
    loaded(nested, "nested_traversal", { prompt_id: "p2", trigger_file_path: join(project, "apps/web/a.ts") });
    expect(submit(FACT_CUE, "p2")).not.toContain("postgres");
    compact();
    expect(submit(FACT_CUE, "p3")).toContain("postgres");
  });

  test("an eager file stays in the shadow set across a compaction", () => {
    loaded(write(join(project, "CLAUDE.md"), "The database is postgres.\n"), "session_start");
    submit(FACT, "p1");
    compact();
    expect(submit(FACT_CUE, "p2")).not.toContain("postgres");
  });

  test("a path_glob_match rule leaves at /clear too", () => {
    const rule = write(join(project, ".claude", "rules", "db.md"), "The database is postgres.\n");
    submit(FACT, "p1");
    loaded(rule, "path_glob_match", { prompt_id: "p2", globs: ["db/**"] });
    expect(submit(FACT_CUE, "p2")).not.toContain("postgres");
    hook({ hook_event_name: "SessionStart", source: "clear" });
    expect(submit(FACT_CUE, "p3")).toContain("postgres");
  });
});

describe("D27: AGENTS.md and auto-memory MEMORY.md, read from disk", () => {
  test("AGENTS.md counts where the project has no CLAUDE.md (Claude Code's default loads it instead)", () => {
    write(join(project, "AGENTS.md"), "The database is postgres.\n");
    submit(FACT, "p1");
    expect(submit(FACT_CUE, "p2")).not.toContain("postgres");
  });

  test("AGENTS.md beside a CLAUDE.md is not loaded by default, so it does not count", () => {
    write(join(project, "AGENTS.md"), "The database is postgres.\n");
    loaded(write(join(project, "CLAUDE.md"), "# Project\n"), "session_start");
    submit(FACT, "p1");
    expect(submit(FACT_CUE, "p2")).toContain("postgres");
  });

  test("the project's auto-memory MEMORY.md counts (Claude Code's projects/<project>/memory folder)", () => {
    const projects = join(dir, "claude", "projects");
    const transcript = join(projects, "-the-session-folder", `${SESSION}.jsonl`);
    const folder = realpathSync(project).replace(/[^a-zA-Z0-9]/g, "-");
    write(join(projects, folder, "memory", "MEMORY.md"), "- The database is postgres.\n");
    submit(FACT, "p1", { transcript_path: transcript });
    expect(submit(FACT_CUE, "p2", { transcript_path: transcript })).not.toContain("postgres");
  });
});

describe("D27: registration", () => {
  test("the plugin, `eden setup` and `eden doctor` register InstructionsLoaded", () => {
    const plugin = JSON.parse(
      readFileSync(join(import.meta.dir, "../../../plugins/eden-memory/hooks/hooks.json"), "utf8"),
    );
    expect(Object.keys(plugin.hooks)).toContain("InstructionsLoaded");
    expect(Object.keys(installedHooks(() => "eden hook"))).toContain("InstructionsLoaded");
    expect(MEMORY_HOOK_EVENTS).toContain("InstructionsLoaded");
  });

  test("InstructionsLoaded writes only its window's shadow log, opens no store and prints nothing", () => {
    const out = hook({
      hook_event_name: "InstructionsLoaded",
      file_path: write(join(project, "CLAUDE.md"), "x\n"),
      memory_type: "Project",
      load_reason: "session_start",
    });
    expect(out).toBeNull();
    const memory = join(dir, "memory");
    expect(readdirSync(join(memory, "windows", SESSION))).toEqual(["shadow.log"]);
    expect(readdirSync(memory).filter((name) => name !== "windows" && name !== "hook.log.d")).toEqual([]);
  });
});
