/**
 * P3.2 at the hook (A4 §2; D2, D4): a window's place from what its prompts named and its batches touched, the scope
 * each encoded row is stored at, what a Submit or a SubagentStart may deliver from it, the two-scope bullet and its
 * ledger keys, a repo's first catalog at SessionStart, and P3.1's rebuild follow-ups. X7: `off` answers nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openMemory, storeRows } from "../../../src/index";
import { readLedger } from "../../../src/memory-ledger";
import { storeFor } from "../../../src/memory-repo";
import { readCatalog } from "../../../src/memory-scopes";
import { consolidate } from "../../../src/sleep";
import { memoryHookResponse } from "./memory-hook";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const CLERK = "In apps/web the auth provider is Clerk.";
const CLI_AUTH = "packages/cli has no auth.";

let dir = "";
let top = "";
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_FLAG_DELIVER_SUBAGENT"] as const;
const FLAG_SUBMIT = "EDEN_FLAG_DELIVER_SUBMIT";
const prev = Object.fromEntries([...ENV_KEYS, FLAG_SUBMIT].map((key) => [key, process.env[key]]));

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function put(base: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  }
}

const commit = (at: string) => {
  git(at, "add", "-A");
  git(at, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "c");
};

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "eden-hook-place-")));
  top = join(dir, "repo");
  put(top, {
    "package.json": JSON.stringify({ name: "demo", workspaces: ["apps/*", "packages/*"] }),
    "apps/web/package.json": JSON.stringify({ name: "web" }),
    "apps/web/app/login.ts": "export function login() {}\n",
    "packages/cli/package.json": JSON.stringify({ name: "cli" }),
    "packages/cli/src/index.ts": "export function main() {}\n",
    "packages/cli/src/login.ts": "export function login() {}\n",
  });
  git(top, "init", "-q", "-b", "main");
  commit(top);
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  process.env.EDEN_FLAG_DELIVER_SUBAGENT = "on";
  delete process.env.EDEN_MEMORY;
  delete process.env[FLAG_SUBMIT];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const store = () => storeFor(process.env.EDEN_MEMORY_DIR!, top);
const win = (session: string) => join(process.env.EDEN_MEMORY_DIR!, "windows", session);
const ctxLog = (session: string) =>
  readFileSync(join(win(session), "ctx.log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const rows = () => storeRows(join(store(), "memories.jsonl"));
const scopeOf = (text: string) => rows().find((row) => row.text.startsWith(text))?.scope;

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

function read(session: string, id: string, ...files: string[]): void {
  hook("PostToolBatch", session, {
    prompt_id: id,
    tool_calls: files.map((file, n) => ({
      tool_name: "Read",
      tool_use_id: `${id}-${n}`,
      tool_input: { file_path: join(top, file) },
      tool_response: "1\t//",
    })),
  });
}

/** An earlier session states each folder's auth, naming its folder (A4 §2: the prompt's places). */
function plant(): void {
  hook("SessionStart", "s-facts", { source: "startup" });
  submit("s-facts", CLERK, "f1");
  tick();
  submit("s-facts", CLI_AUTH, "f2");
  tick(86_400_000);
}

/** The wide events of an event, from the day files (`hook.log.d`). */
function events(name: string): Record<string, unknown>[] {
  const days = join(process.env.EDEN_MEMORY_DIR!, "hook.log.d");
  return readdirSync(days)
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .flatMap((file) => readFileSync(join(days, file), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.ev === name);
}

describe("a repo's place at the hook", () => {
  test("a repo's first SessionStart builds its catalog, so its first prompt's row is stored where it names", () => {
    hook("SessionStart", "s1", { source: "startup" });
    expect(readCatalog(store())?.scopes).toEqual(["", "apps/web", "packages/cli"]);
    expect(events("SessionStart")[0]!.catalog).toBe(3);
    submit("s1", CLERK, "p1");
    expect(scopeOf("In apps/web the auth provider is Clerk")).toBe("apps/web");
    // X11: the window keeps the prompt's places, never its text.
    expect(ctxLog("s1")).toEqual([{ k: "prompt", paths: ["apps/web"], prompt_id: "p1" }]);
  });

  test("a prompt naming no place is stored at the working scope: the read set its window's turns make", () => {
    hook("SessionStart", "s1", { source: "startup" });
    submit("s1", "look at the login flow", "p1");
    read("s1", "p1", "packages/cli/src/login.ts");
    submit("s1", "The login flow should retry twice before it gives up.", "p2");
    expect(scopeOf("The login flow should retry twice")).toBe("packages/cli");
    expect(scopeOf("look at the login flow")).toBe("");
  });

  test("Submit delivers no row of a sibling folder", () => {
    plant();
    hook("SessionStart", "s2", { source: "startup" });
    const cli = submit("s2", "which auth does packages/cli/src/index.ts use?", "p1");
    expect(cli).toContain("has no auth");
    expect(cli).not.toContain("Clerk");
    const web = submit("s2", "which auth provider does apps/web/app/login.ts use?", "p2");
    expect(web).toContain("Clerk");
    expect(web).not.toContain("no auth");
    expect(events("UserPromptSubmit").at(-1)!.read).toBe(1);
  });

  test("a turn on both folders: one bullet for the slot, and the ledger records both rows", () => {
    plant();
    hook("SessionStart", "s3", { source: "startup" });
    submit("s3", "look at both login flows", "p1");
    read("s3", "p1", "apps/web/app/login.ts", "packages/cli/src/login.ts");
    const packet = submit("s3", "make apps/web/app/login.ts and packages/cli/src/login.ts behave the same", "p2");
    expect(packet).toContain("- auth provider — apps/web: Clerk · packages/cli: has no auth (you said, 1 day ago)");
    const event = events("UserPromptSubmit").at(-1)!;
    expect(event.read).toBe(2);
    const cids = event.cids as string[];
    expect(cids.some((cid) => cid.includes("/s:apps/web|"))).toBe(true);
    expect(cids).toHaveLength(2);
    const delivered = [...readLedger(win("s3")).delivered.keys()];
    expect(delivered).toEqual(expect.arrayContaining(cids));
    // Given once: the next cue on both folders finds both rows refractory.
    expect(submit("s3", "again: make apps/web/app/login.ts and packages/cli/src/login.ts match", "p3")).not.toContain(
      "Clerk",
    );
  });
});

describe("what a batch records of its place", () => {
  test("Bash paths apart from tool paths (D4: Bash 1, a tool path 2 or 1)", () => {
    hook("PostToolBatch", "s1", {
      prompt_id: "p1",
      tool_calls: [
        { tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: join(top, "apps/web/app/login.ts") } },
        { tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "cd packages/cli && bun test src/index.ts" } },
      ],
    });
    expect(ctxLog("s1")).toEqual([
      {
        k: "batch",
        prompt_id: "p1",
        paths: [join(top, "apps/web/app/login.ts")],
        bash: ["packages/cli", "packages/cli/src/index.ts"],
        exit: [0],
        sig: [],
      },
    ]);
  });

  test("a subagent's batch is its own, and its session's subagent paths (D2)", () => {
    hook("PostToolBatch", "s1", {
      agent_id: "a1",
      agent_type: "Explore",
      prompt_id: "p1",
      tool_calls: [{ tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: join(top, "apps/web/x.ts") } }],
    });
    expect(ctxLog("s1--a1")[0]).toMatchObject({ k: "batch", paths: [join(top, "apps/web/x.ts")] });
    expect(ctxLog("s1")).toEqual([{ k: "sub", paths: [join(top, "apps/web/x.ts")] }]);
  });
});

describe("SubagentStart's place (A4 §5.3)", () => {
  test("with no launch record, the parent's read set: its folder's rows, never a sibling's", () => {
    plant();
    hook("SessionStart", "s4", { source: "startup" });
    submit("s4", "refactor packages/cli/src/index.ts", "p1");
    const packet = packetOf(hook("SubagentStart", "s4", { agent_id: "a1", agent_type: "general-purpose" }));
    expect(packet).toContain("has no auth");
    expect(packet).not.toContain("Clerk");
    const scope = JSON.parse(readFileSync(join(win("s4--a1"), "scope.json"), "utf8"));
    expect(scope).toMatchObject({ from: "parent", scopes: ["packages/cli"] });
  });
});

describe("P3.1's rebuild follow-ups", () => {
  function write(file: string, cwd = top): void {
    hook("PostToolBatch", "s1", {
      cwd,
      prompt_id: "p1",
      tool_calls: [{ tool_name: "Write", tool_use_id: `w-${file}`, tool_input: { file_path: join(cwd, file) } }],
    });
  }
  const rebuilt = () => events("PostToolBatch").filter((event) => event.catalog !== undefined).length;

  test("a write into a waiting folder rebuilds only when the file is there and git lists it", () => {
    put(top, { ".gitignore": "dist/\n", "packages/new/package.json": JSON.stringify({ name: "new" }) });
    commit(top);
    hook("SessionStart", "s1", { source: "startup" });
    expect(readCatalog(store())?.waiting).toEqual(["packages/new"]);
    write("packages/new/index.ts");
    put(top, { "packages/new/dist/out.js": "" });
    write("packages/new/dist/out.js");
    expect(rebuilt()).toBe(0);
    put(top, { "packages/new/index.ts": "" });
    write("packages/new/index.ts");
    expect(rebuilt()).toBe(1);
    expect(readCatalog(store())?.scopes).toContain("packages/new");
  });

  test("a manifest written in a linked worktree lists nothing: the catalog lists the main checkout", () => {
    hook("SessionStart", "s1", { source: "startup" });
    const linked = join(dir, "linked");
    git(top, "worktree", "add", "-q", linked);
    put(linked, { "packages/other/package.json": JSON.stringify({ name: "other" }) });
    write("packages/other/package.json", linked);
    expect(rebuilt()).toBe(0);
    write("packages/cli/package.json");
    expect(rebuilt()).toBe(1);
  });
});

describe("X7 and fail-open", () => {
  test("`off`: the Submit answers nothing and writes no ledger; the prompt's places are still recorded", () => {
    plant();
    process.env[FLAG_SUBMIT] = "off";
    hook("SessionStart", "s5", { source: "startup" });
    expect(submit("s5", "which auth does packages/cli/src/index.ts use?", "p1")).toBe("");
    expect(existsSync(join(win("s5"), "delivery.log"))).toBe(false);
    expect(ctxLog("s5")).toEqual([{ k: "prompt", paths: ["packages/cli/src/index.ts"], prompt_id: "p1" }]);
  });

  test("an unreadable ctx.log: the prompt's own places still place the Submit", () => {
    plant();
    hook("SessionStart", "s6", { source: "startup" });
    mkdirSync(join(win("s6"), "ctx.log"), { recursive: true });
    const packet = submit("s6", "which auth does packages/cli/src/index.ts use?", "p1");
    expect(packet).toContain("has no auth");
    expect(packet).not.toContain("Clerk");
    expect(events("UserPromptSubmit").at(-1)!.err).toBeUndefined();
  });

  test("no readable catalog: the place is unknown, so every row is read and new rows are stored unplaced", () => {
    plant();
    // A session's start would build it again: this Submit runs before any rebuild.
    writeFileSync(join(store(), "scopes.json"), "{");
    const packet = submit("s7", "which auth does packages/cli/src/index.ts use? apps/web/app/login.ts too", "p1");
    expect(packet).toContain("has no auth");
    expect(packet).toContain("Clerk");
    expect(events("UserPromptSubmit").at(-1)!.read).toBeUndefined();
    expect(scopeOf("which auth does packages/cli")).toBeUndefined();
  });
});

/** Two sibling folders each state their auth provider as a copula, naming a file of their folder. */
function plantCopulas(): void {
  hook("SessionStart", "s-facts", { source: "startup" });
  submit("s-facts", "The auth provider is Clerk in apps/web/app/login.ts.", "f1");
  tick();
  submit("s-facts", "The auth provider is Passport in packages/cli/src/login.ts.", "f2");
  tick(86_400_000);
}

const live = () => rows().filter((row) => row.invalidAt === undefined && row.invalidBy === undefined);

describe("review round 1's probes (A4 §2–3.2 as P3.2 reads them)", () => {
  test("the two-scope bullet's other value is never a prompt the user typed, nor one that only names the subject", () => {
    plant();
    hook("SessionStart", "s3", { source: "startup" });
    submit("s3", "which auth does packages/cli/src/index.ts use?", "p1");
    tick();
    submit("s3", "look at both login flows", "p2");
    read("s3", "p2", "apps/web/app/login.ts", "packages/cli/src/login.ts");
    const packet = submit("s3", "make packages/cli/src/login.ts use the same auth as apps/web/app/login.ts", "p3");
    expect(packet).not.toMatch(/packages\/cli: (?:which auth|make packages)/);
  });

  test("a two-scope turn's labelled bullet shows no raw packet label", () => {
    hook("SessionStart", "s0", { source: "startup" });
    submit("s0", "look at the login page", "p0");
    read("s0", "p0", "apps/web/app/login.ts");
    submit("s0", "The login redirect waits for the session cookie before it navigates.", "p1");
    tick(86_400_000);
    hook("SessionStart", "s1", { source: "startup" });
    submit("s1", "look at both login flows", "q1");
    read("s1", "q1", "apps/web/app/login.ts", "packages/cli/src/login.ts");
    const packet = submit(
      "s1",
      "why does the login redirect wait in apps/web/app/login.ts and packages/cli/src/login.ts",
      "q2",
    );
    expect(packet).toContain("- apps/web: The login redirect waits");
    expect(packet).not.toMatch(/\[(?:fact|episode)/);
  });

  test("the idle sleep's consolidate supersedes no value of a sibling folder", () => {
    plantCopulas();
    const mem = openMemory({ dir: store(), perRepo: true });
    try {
      consolidate(mem as never);
    } finally {
      mem.close();
    }
    expect(
      live()
        .map((row) => row.scope)
        .sort(),
    ).toEqual(["apps/web", "packages/cli"]);
  });

  test("an apps/web cue on the overwrite route gets apps/web's value, never packages/cli's", () => {
    plantCopulas();
    hook("SessionStart", "s2", { source: "startup" });
    const packet = submit("s2", "which auth provider does apps/web/app/login.ts use? The Lead is Bob", "p1");
    expect(packet).not.toContain("Passport");
  });

  test("a switch at apps/web leaves packages/cli's same old value standing at delivery", () => {
    hook("SessionStart", "s-facts", { source: "startup" });
    submit("s-facts", "In apps/web the auth provider is Auth0.", "f1");
    tick();
    submit("s-facts", "In packages/cli the auth provider is Auth0.", "f2");
    tick();
    submit("s-facts", "In apps/web the auth provider is Clerk.", "f3");
    tick(86_400_000);
    expect(
      live()
        .filter((row) => row.text.includes("Auth0"))
        .map((row) => row.scope),
    ).toEqual(["packages/cli"]);
    hook("SessionStart", "s2", { source: "startup" });
    expect(submit("s2", "which auth provider does packages/cli/src/index.ts use?", "p1")).toContain("Auth0");
  });

  test("D7: a root slot typed while working in one folder is stored at the root, and every folder sees it", () => {
    hook("SessionStart", "s1", { source: "startup" });
    submit("s1", "look at the login page", "p1");
    read("s1", "p1", "apps/web/app/login.ts");
    submit("s1", "The package manager is pnpm.", "p2");
    const fact = rows().find((row) => row.kind === "fact" && row.text.startsWith("The package manager is pnpm"));
    expect(fact?.scope).toBe("");
    tick(86_400_000);
    hook("SessionStart", "s2", { source: "startup" });
    const packet = submit("s2", "which package manager installs packages/cli/src/index.ts deps?", "q1");
    expect(packet).toContain("pnpm");
  });
});

describe("review round 2's probes: the semantic store's unscoped values (guards)", () => {
  test("packages/cli's value of a subject never scrubs apps/web's rule or fact at the idle sleep", () => {
    hook("SessionStart", "s1", { source: "startup" });
    submit("s1", "look at the web login", "p1");
    read("s1", "p1", "apps/web/app/login.ts");
    submit("s1", "The auth provider is Clerk.", "p2");
    submit("s1", "Always use Clerk for login.", "p3");
    tick();
    hook("SessionStart", "s2", { source: "startup" });
    submit("s2", "look at the cli login", "q1");
    read("s2", "q1", "packages/cli/src/login.ts");
    submit("s2", "The auth provider is Passport.", "q2");
    tick();
    const mem = openMemory({ dir: store(), perRepo: true });
    try {
      consolidate(mem as never);
    } finally {
      mem.close();
    }
    const after = live().map((row) => [row.text, row.scope, row.kind]);
    expect(after).toContainEqual(["The auth provider is Clerk", "apps/web", "fact"]);
    expect(after.some(([text]) => String(text).startsWith("Always use Clerk"))).toBe(true);
  });

  test("after packages/cli states its value, an apps/web cue still gets apps/web's own (no unscoped tombstone hides it)", () => {
    hook("SessionStart", "s1", { source: "startup" });
    submit("s1", "look at the web login", "p1");
    read("s1", "p1", "apps/web/app/login.ts");
    submit("s1", "The auth provider is Clerk.", "p2");
    tick();
    hook("SessionStart", "s2", { source: "startup" });
    submit("s2", "look at the cli login", "q1");
    read("s2", "q1", "packages/cli/src/login.ts");
    submit("s2", "The auth provider is Passport.", "q2");
    tick(86_400_000);
    const mem = openMemory({ dir: store(), perRepo: true });
    try {
      consolidate(mem as never);
    } finally {
      mem.close();
    }
    hook("SessionStart", "s3", { source: "startup" });
    submit("s3", "look at the web login again", "r1");
    read("s3", "r1", "apps/web/app/login.ts");
    const packet = submit("s3", "which auth provider does apps/web/app/login.ts use?", "r2");
    expect(packet).not.toContain("Passport");
    expect(packet).toContain("Clerk");
  });
});

describe("review round 4: rows that name only the root's files", () => {
  test("a tool result naming a root file, while working in apps/web, is the root's and never labelled apps/web", () => {
    put(top, { "scripts/db.ts": "export {};\n" });
    commit(top);
    hook("SessionStart", "s1", { source: "startup" });
    submit("s1", "look at the web login", "p1");
    read("s1", "p1", "apps/web/app/login.ts");
    hook("PostToolUse", "s1", {
      tool_name: "Write",
      tool_input: { file_path: join(top, "scripts/db.ts") },
      tool_response: `File created successfully at: ${join(top, "scripts/db.ts")}`,
    });
    const row = rows().find((r) => r.text.includes("scripts/db.ts"));
    expect(row?.scope).toBe("");
    tick(86_400_000);
    hook("SessionStart", "s2", { source: "startup" });
    submit("s2", "look at both login flows", "q1");
    read("s2", "q1", "apps/web/app/login.ts", "packages/cli/src/login.ts");
    const packet = submit("s2", "where is the db script for apps/web/app/login.ts and packages/cli/src/login.ts", "q2");
    expect(packet).not.toMatch(/apps\/web: [^\n]*scripts\/db\.ts/);
  });
});

describe("review round 4's probes: a session started in a package", () => {
  const web = () => join(top, "apps/web");

  test("a path relative to the session's folder is that folder's, not the root's", () => {
    hook("SessionStart", "s1", { source: "startup", cwd: web() });
    hook("UserPromptSubmit", "s1", { cwd: web(), prompt: "look at the login", prompt_id: "p1" });
    read("s1", "p1", "apps/web/app/login.ts");
    const said = "The redirect in app/login.ts fires twice before the session cookie lands.";
    hook("UserPromptSubmit", "s1", { cwd: web(), prompt: said, prompt_id: "p2" });
    expect(scopeOf("The redirect in app/login.ts fires twice")).toBe("apps/web");
  });

  test("a fact naming a file of the session's folder is never seen from a sibling folder", () => {
    hook("SessionStart", "s1", { source: "startup", cwd: web() });
    hook("UserPromptSubmit", "s1", { cwd: web(), prompt: "look at the login", prompt_id: "p1" });
    read("s1", "p1", "apps/web/app/login.ts");
    hook("UserPromptSubmit", "s1", {
      cwd: web(),
      prompt: "The session store in app/session.ts is redis.",
      prompt_id: "p2",
    });
    tick(86_400_000);
    hook("SessionStart", "s2", { source: "startup" });
    expect(submit("s2", "which session store does packages/cli/src/index.ts use?", "q1")).not.toContain("redis");
  });
});
