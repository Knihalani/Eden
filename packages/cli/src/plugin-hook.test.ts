/**
 * P0.1: the eden-memory plugin's hook (`plugins/eden-memory/scripts/hook.ts`) loads Eden in-process wherever
 * Claude Code runs it: in place (`--plugin-dir`, the harness) and as the copy `/plugin install` puts in Claude's
 * plugin cache. When Eden cannot load, it fails open within the Submit budget: exit 0, nothing printed, no spawn,
 * no network, and the cause recorded once in `$EDEN_HOME/plugin-fallback.jsonl`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pluginSubmitCommand } from "./doctor-memory";

const REPO = join(import.meta.dir, "../../..");
const PLUGIN = join(REPO, "plugins", "eden-memory");
const SUBMIT = {
  hook_event_name: "UserPromptSubmit",
  session_id: "s-plugin",
  prompt: "we use pnpm in this repo, never npm",
};

const tmp = mkdtempSync(join(tmpdir(), "eden-plugin-hook-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let dirs = 0;

function freshDir(name: string): string {
  const dir = join(tmp, `${name}-${++dirs}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The layout `/plugin install eden-memory@eden` leaves in a Claude config dir: a copy of the plugin in the cache
 * and, for a directory marketplace, its source path in `known_marketplaces.json`.
 */
function installCopy(marketplace: string | null): string {
  const claudeDir = freshDir("claude");
  const copy = join(claudeDir, "plugins", "cache", "eden", "eden-memory", "0.2.0");
  cpSync(PLUGIN, copy, { recursive: true });
  if (marketplace) {
    const known = { eden: { source: { source: "directory", path: marketplace }, installLocation: marketplace } };
    writeFileSync(join(claudeDir, "plugins", "known_marketplaces.json"), JSON.stringify(known));
  }
  return copy;
}

/** A checkout with the memory hook's file but not its dependencies, as a clone before `bun install` is. */
function checkoutWithoutDependencies(): string {
  const root = freshDir("no-deps");
  const hook = join(root, "packages", "cli", "src", "memory-hook.ts");
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, 'export { redact as runMemoryHookStdin } from "@eden/not-installed";\n');
  return root;
}

type Hooked = { code: number; stdout: string; stderr: string; ms: number; spawnedEden: boolean; home: string };

/**
 * Runs a plugin's Submit hook command (`hooks/hooks.json`) once in a fresh process with its own Eden home, as Claude
 * Code does. `eden` on PATH is a stub that records a call, so a spawn fallback shows.
 */
async function runHook(pluginRoot: string, extra: Record<string, string> = {}, home = freshDir("home")) {
  const stub = join(home, "bin");
  const spawned = join(home, "eden-was-spawned");
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, "eden"), `#!/bin/sh\ntouch '${spawned}'\nexit 127\n`, { mode: 0o755 });
  const env = {
    PATH: `${stub}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: tmpdir(),
    EDEN_HOME: join(home, ".eden"),
    EDEN_MEMORY_DIR: join(home, ".eden", "memory"),
    ...extra,
  };
  const started = performance.now();
  const proc = Bun.spawn(["/bin/sh", "-c", pluginSubmitCommand(pluginRoot)!], {
    env: { ...env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    stdin: new Blob([JSON.stringify({ ...SUBMIT, cwd: home })]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ms = performance.now() - started;
  return { code, stdout, stderr, ms, spawnedEden: existsSync(spawned), home } satisfies Hooked;
}

function fallbacks(home: string): Array<{ t: string; plugin: string; cause: string }> {
  const log = join(home, ".eden", "plugin-fallback.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { t: string; plugin: string; cause: string });
}

/**
 * Two Submits of one prompt on one Eden home: the first stores the prompt's rule (and prints `{}`), the second packs
 * it. A crash would print `{}` too (`hooks.json`'s `|| echo '{}'`), but never the packet, and it writes to stderr.
 */
async function submitTwice(pluginRoot: string, extra: Record<string, string> = {}) {
  const first = await runHook(pluginRoot, extra);
  const second = await runHook(pluginRoot, extra, first.home);
  return { first, second, outputs: [first.stdout, second.stdout] };
}

function expectLoaded(run: Awaited<ReturnType<typeof submitTwice>>) {
  for (const out of [run.first, run.second]) {
    expect(out).toMatchObject({ code: 0, stderr: "", spawnedEden: false });
  }
  expect(fallbacks(run.first.home)).toEqual([]);
}

/** The hook run in place from this checkout: what every working copy must print. */
const inPlace = await submitTwice(PLUGIN);

describe("the plugin loads Eden in-process", () => {
  test("in place, from this checkout: the second Submit packs the rule the first stored", () => {
    expectLoaded(inPlace);
    expect(inPlace.first.stdout).toBe("{}");
    expect(inPlace.second.stdout).toContain("Eden memory, recalled from earlier sessions:");
    expect(inPlace.second.stdout).toContain("we use pnpm in this repo, never npm");
  });

  test("as an installed copy, through the directory marketplace it was installed from", async () => {
    const run = await submitTwice(installCopy(REPO));
    expectLoaded(run);
    expect(run.outputs).toEqual(inPlace.outputs);
  });

  test("as an installed copy, through EDEN_ROOT", async () => {
    const run = await submitTwice(installCopy(null), { EDEN_ROOT: REPO });
    expectLoaded(run);
    expect(run.outputs).toEqual(inPlace.outputs);
  });

  test("its own checkout comes before EDEN_ROOT", async () => {
    const run = await submitTwice(PLUGIN, { EDEN_ROOT: checkoutWithoutDependencies() });
    expectLoaded(run);
    expect(run.outputs).toEqual(inPlace.outputs);
  });
});

describe("when Eden cannot load, the plugin fails open and says why once", () => {
  test("no checkout found: exit 0, nothing printed, nothing spawned, the cause logged once", async () => {
    const copy = installCopy(null);
    const first = await runHook(copy);
    const second = await runHook(copy, {}, first.home);
    for (const out of [first, second]) {
      expect(out).toMatchObject({ code: 0, stdout: "", stderr: "", spawnedEden: false });
      // A wait or a spawn in the chain takes seconds; the budget is 150 ms (measured in the P0.1 report).
      expect(out.ms).toBeLessThan(1500);
    }
    const logged = fallbacks(first.home);
    expect(logged).toHaveLength(1);
    // Bun resolves the script's path, so the log names the copy by its real path (macOS: /var is /private/var).
    expect(logged[0]!.plugin).toBe(realpathSync(copy));
    expect(logged[0]!.cause).toContain("no Eden checkout");
    expect(logged[0]!.cause).toContain("EDEN_ROOT");
  });

  test("a checkout without its dependencies: the import error is logged once, and a new cause gets its own line", async () => {
    const copy = installCopy(checkoutWithoutDependencies());
    const first = await runHook(copy);
    const again = await runHook(copy, {}, first.home);
    for (const out of [first, again]) expect(out).toMatchObject({ code: 0, stdout: "", spawnedEden: false });
    expect(fallbacks(first.home)).toHaveLength(1);
    expect(fallbacks(first.home)[0]!.cause).toContain("@eden/not-installed");

    const other = await runHook(installCopy(null), {}, first.home);
    expect(other.stdout).toBe("");
    expect(fallbacks(first.home)).toHaveLength(2);
  });

  test("a copy from a git marketplace does not run Claude Code's clone of it", async () => {
    const copy = installCopy(null);
    const plugins = dirname(dirname(dirname(dirname(copy))));
    const known = { eden: { source: { source: "github", repo: "Knihalani/Eden" }, installLocation: REPO } };
    writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify(known));
    const out = await runHook(copy);
    expect(out).toMatchObject({ code: 0, stdout: "", spawnedEden: false });
    expect(fallbacks(out.home)[0]!.cause).toContain("no Eden checkout");
  });

  test("the log holds no prompt text", async () => {
    const out = await runHook(installCopy(null));
    expect(readFileSync(join(out.home, ".eden", "plugin-fallback.jsonl"), "utf8")).not.toContain("pnpm");
  });
});
