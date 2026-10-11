/**
 * P0.8, EXECUTION §5's fail-open contract: a throw injected into each hook entry point exits 0 with empty stdout and
 * stderr. Each entry point is a command the plugin's `hooks/hooks.json` registers, run as Claude Code runs it
 * (`/bin/sh -c`, `CLAUDE_PLUGIN_ROOT`), against an Eden checkout whose memory hook (and PreToolUse guard, P2.3) fails
 * in each way a process can: at import, by rejecting, by an uncaught exception after it returns, by exiting non-zero
 * with stderr, against a store that cannot be read, and with no `bun` on PATH at all.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "../../..");
const PLUGIN = join(REPO, "plugins", "eden-memory");
const BUN_DIR = dirname(process.execPath);
/** How each command ends, so that even a missing `bun` exits 0 silently (`doctor-memory.ts` strips it to probe). */
const FAIL_OPEN_SUFFIX = " 2>/dev/null || true";

const tmp = mkdtempSync(join(tmpdir(), "eden-fail-open-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let dirs = 0;

const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8")).hooks as Record<
  string,
  Array<{ hooks: Array<{ command: string }> }>
>;
const ENTRY_POINTS = Object.entries(hooks).flatMap(([event, groups]) =>
  groups.flatMap((group) => group.hooks.map((handler) => ({ event, command: handler.command }))),
);

/** A plugin copy with no checkout of its own, so it runs the Eden that EDEN_ROOT names. */
function pluginCopy(): string {
  const copy = join(tmp, `plugin-${++dirs}`);
  cpSync(PLUGIN, copy, { recursive: true });
  return copy;
}

/**
 * An Eden checkout whose memory hook module is `source`, and whose PreToolUse guard (P2.3) takes every call up and
 * fails the same way: `runMemoryHookStdin` is the guard's `runGuardHook` there.
 */
function edenWith(source: string): string {
  const root = join(tmp, `eden-${++dirs}`);
  const src = join(root, "packages", "cli", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "memory-hook.ts"), source);
  writeFileSync(join(src, "memory-guard-hook.ts"), source.replaceAll("runMemoryHookStdin", "runGuardHook"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "memory-guard-match.ts"), "export const guardedCall = () => true;\n");
  return root;
}

const FAULTS: Record<string, string> = {
  "throws at import": 'throw new Error("injected at import");\n',
  rejects: 'export async function runMemoryHookStdin() {\n  throw new Error("injected");\n}\n',
  "throws after it returns":
    'export async function runMemoryHookStdin() {\n  setTimeout(() => {\n    throw new Error("injected later");\n  }, 0);\n}\n',
  "exits 2 with stderr":
    'export async function runMemoryHookStdin() {\n  process.stderr.write("injected");\n  process.exit(2);\n}\n',
};

type Ran = { code: number; stdout: string; stderr: string };

async function run(command: string, event: string, env: Record<string, string>): Promise<Ran> {
  const home = join(tmp, `home-${++dirs}`);
  mkdirSync(home, { recursive: true });
  const payload = {
    hook_event_name: event,
    session_id: "s-fail-open",
    prompt: "fix the login",
    cwd: home,
    // A call every guard handler takes up (P2.3): a class matches it.
    ...(event === "PreToolUse" ? { tool_name: "Bash", tool_input: { command: "git push --force origin main" } } : {}),
  };
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    env: {
      PATH: `${BUN_DIR}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: tmpdir(),
      EDEN_HOME: join(home, ".eden"),
      EDEN_MEMORY_DIR: join(home, ".eden", "memory"),
      ...env,
    },
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const QUIET: Ran = { code: 0, stdout: "", stderr: "" };

describe("every registered entry point fails open (EXECUTION §5)", () => {
  test("hooks.json registers the memory events, each command ending in the fail-open suffix", () => {
    expect(ENTRY_POINTS.map((point) => point.event).sort()).toEqual(
      [
        "InstructionsLoaded",
        "PostCompact",
        "PostToolBatch",
        "PreCompact",
        // The policy guard (P2.3): 16 Bash handlers and the MCP merge matcher.
        ...Array<string>(17).fill("PreToolUse"),
        "SessionEnd",
        "SessionStart",
        "Stop",
        "Stop",
        "SubagentStop",
        "UserPromptSubmit",
      ].sort(),
    );
    for (const { command } of ENTRY_POINTS) expect(command).toEndWith(FAIL_OPEN_SUFFIX);
  });

  for (const [fault, source] of Object.entries(FAULTS))
    test(`a memory hook that ${fault}: exit 0, nothing on stdout or stderr`, async () => {
      const copy = pluginCopy();
      const eden = edenWith(source);
      const env = { CLAUDE_PLUGIN_ROOT: copy, EDEN_ROOT: eden };
      const ran = await Promise.all(ENTRY_POINTS.map(({ command, event }) => run(command, event, env)));
      expect(ran).toEqual(ENTRY_POINTS.map(() => QUIET));
    });

  test("this checkout's Eden over a store that cannot be read: exit 0, nothing printed", async () => {
    const ran = await Promise.all(
      ENTRY_POINTS.map(async ({ command, event }) => {
        const broken = join(tmp, `broken-${++dirs}`);
        writeFileSync(broken, "not a directory\n");
        return run(command, event, { CLAUDE_PLUGIN_ROOT: PLUGIN, EDEN_MEMORY_DIR: broken });
      }),
    );
    expect(ran).toEqual(ENTRY_POINTS.map(() => QUIET));
  });

  test("no bun on PATH: exit 0, nothing printed (the shell's own error included)", async () => {
    const env = { CLAUDE_PLUGIN_ROOT: PLUGIN, PATH: "/usr/bin:/bin" };
    const ran = await Promise.all(ENTRY_POINTS.map(({ command, event }) => run(command, event, env)));
    expect(ran).toEqual(ENTRY_POINTS.map(() => QUIET));
  });
});
