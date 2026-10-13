/**
 * P3.3 at the hook (D7, A4 §3.1–3.2, §4; D31): what the user types is encoded as keyed slot rows, a root slot is
 * written at the repo's root wherever it was typed, a switch supersedes by key and comes back once as an `Updated:`
 * item, and a superseded value stays out of every later packet, episodes included.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { storeRows, superseded } from "../../../src/index";
import { storeFor } from "../../../src/memory-repo";
import { memoryHookResponse } from "./memory-hook";

const NOW = Date.parse("2026-10-13T12:00:00Z");

let dir = "";
let top = "";
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "eden-hook-slots-")));
  top = join(dir, "repo");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "demo", workspaces: ["apps/*", "packages/*"] }),
    "apps/web/package.json": JSON.stringify({ name: "web" }),
    "apps/web/app/login.ts": "export function login() {}\n",
    "packages/cli/package.json": JSON.stringify({ name: "cli" }),
    "packages/cli/src/index.ts": "export function main() {}\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), text);
  }
  git(top, "init", "-q", "-b", "main");
  git(top, "add", "-A");
  git(top, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "c");
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  delete process.env.EDEN_MEMORY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const rows = () => storeRows(join(storeFor(process.env.EDEN_MEMORY_DIR!, top), "memories.jsonl"));
const row = (text: string) => rows().find((r) => r.text.startsWith(text));

function tick(ms = 60_000): void {
  process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + ms);
}

function hook(event: string, session: string, fields: Record<string, unknown> = {}): Record<string, unknown> | null {
  const out = memoryHookResponse({ hook_event_name: event, session_id: session, cwd: top, ...fields });
  tick(1_000);
  return out;
}

const packetOf = (out: Record<string, unknown> | null) =>
  (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";

function submit(session: string, prompt: string, id: string): string {
  return packetOf(hook("UserPromptSubmit", session, { prompt, prompt_id: id }));
}

/** A Read in a folder, so the window's working scope is that folder (D4). */
function readIn(session: string, id: string, file: string): void {
  hook("PostToolBatch", session, {
    prompt_id: id,
    tool_calls: [
      { tool_name: "Read", tool_use_id: `${id}-0`, tool_input: { file_path: join(top, file) }, tool_response: "1\t//" },
    ],
  });
}

/** The Submit wide events' cids, from the day files (`hook.log.d`). */
function submitCids(): string[][] {
  const days = join(process.env.EDEN_MEMORY_DIR!, "hook.log.d");
  return readdirSync(days)
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .flatMap((file) => readFileSync(join(days, file), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as { ev?: string; cids?: string[] })
    .filter((event) => event.ev === "UserPromptSubmit")
    .map((event) => event.cids ?? []);
}

describe("slot rows at the hook", () => {
  test("R3 E8 / ROADMAP: `we use pnpm here` typed while working in apps/web is pkg.manager=pnpm at the root", () => {
    hook("SessionStart", "s1", { source: "startup" });
    submit("s1", "open the login page", "p1");
    readIn("s1", "p1", "apps/web/app/login.ts");
    submit("s1", "we use pnpm here", "p2");
    expect(row("we use pnpm here")).toMatchObject({ scope: "", slots: [{ k: "pkg.manager", v: "pnpm" }] });
    // A working slot is at the working scope.
    submit("s1", "The database is postgres.", "p3");
    expect(row("The database is postgres")).toMatchObject({ scope: "apps/web", slots: [{ k: "db.engine" }] });
  });

  test("a switch supersedes by key, is given once as an Updated item, and the old value stays out", () => {
    hook("SessionStart", "s1", { source: "startup" });
    submit("s1", "packages/cli uses postgres for its database.", "p1");
    tick(86_400_000);
    hook("SessionStart", "s2", { source: "startup" });
    const first = submit("s2", "which database does packages/cli/src/index.ts use?", "q1");
    expect(first).toContain("postgres");
    expect(submitCids().at(-1)).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/s:packages\/cli\|db\.engine$/)]),
    );
    submit("s2", "packages/cli switched its database from postgres to sqlite.", "q2");
    expect(superseded(row("packages/cli uses postgres")!)).toBe(true);
    const updated = submit("s2", "which database does packages/cli/src/index.ts use now?", "q3");
    // Its text names the value it replaces, so the packet does not add "(was postgres)" (D14).
    expect(updated).toContain("Updated: packages/cli switched its database from postgres to sqlite");
    const again = submit("s2", "and which database does packages/cli/src/index.ts use again?", "q4");
    expect(again).not.toContain("sqlite");
    expect(again).not.toMatch(/uses postgres/);
  });

  test("D31: an episode that carries the superseded value is not delivered after the switch", () => {
    const cue = "how do I start the db for packages/cli/src/index.ts with docker compose?";
    hook("SessionStart", "s1", { source: "startup" });
    submit("s1", "packages/cli uses postgres for its database.", "p1");
    // A typed note that is no fact: an episode (D6), which keeps lexical admission (A7 §4).
    submit("s1", "For packages/cli, start postgres with docker compose up db, then run the seed script.", "p2");
    tick(86_400_000);
    hook("SessionStart", "s2", { source: "startup" });
    // Control: before the switch the cue gets the episode.
    expect(submit("s2", cue, "q1")).toContain("docker compose up db");
    submit("s2", "packages/cli switched its database from postgres to sqlite.", "q2");
    tick(86_400_000);
    hook("SessionStart", "s3", { source: "startup" });
    const packet = submit("s3", cue, "r1");
    expect(packet).not.toContain("docker compose up db");
    // What is left of postgres is the statement of the change (A4 §3.1), not the old value.
    expect(packet).not.toMatch(/uses postgres/);
  });
});
