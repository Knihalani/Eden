/**
 * The fresh-clone check (P0.1): does a new install of Eden memory work, as a user gets it? It clones a commit of this
 * repo into a temp dir outside any repo, with an empty HOME, and checks in order:
 *   1. before `bun install`: the plugin's hook fails open within the Submit budget and logs its cause once;
 *   2. `bun install --frozen-lockfile`, then the CLI loads;
 *   3. the hook run in place (`--plugin-dir`) loads Eden in-process within the budget, and its later runs pack the
 *      rule its first run stored;
 *   4. when `claude` is on PATH: `claude plugin marketplace add` + `claude plugin install eden-memory@eden`, then the
 *      installed copy (in Claude's plugin cache) prints what the in-place hook prints, run for run, within the budget;
 *   5. `eden doctor --memory` exits 0.
 * Hooks run the command `hooks/hooks.json` declares, with a stub `eden` on PATH that records a call, so a spawn
 * fallback shows. Needs the network (`bun install` into an empty cache). Prints one JSON report and exits 0 when
 * every check passes.
 *
 * Usage: bun scripts/fresh-clone-check.ts [<ref>] [--runs N] [--keep]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pluginSubmitCommand } from "../packages/cli/src/doctor-memory";

const BUDGET_MS = 150;
const PROMPT = "we use pnpm in this repo, never npm";

type Check = { name: string; ok: boolean; detail: Record<string, unknown> };
type HookRuns = { exitCodes: number[]; outputs: string[]; p50: number; p95: number; spawnedEden: boolean };

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : 10;
const ref = args.find((a, i) => !a.startsWith("--") && i !== runsAt + 1) ?? "HEAD";
const repo = join(import.meta.dir, "..");
const sha = Bun.spawnSync(["git", "-C", repo, "rev-parse", ref]).stdout.toString().trim();

const tmp = mkdtempSync(join(tmpdir(), "eden-fresh-clone-"));
const clone = join(tmp, "eden");
const home = join(tmp, "home");
const stub = join(tmp, "stub-bin");
const spawnMarker = join(tmp, "eden-was-spawned");
mkdirSync(home);
mkdirSync(stub);
writeFileSync(join(stub, "eden"), `#!/bin/sh\ntouch '${spawnMarker}'\nexit 127\n`, { mode: 0o755 });
const bunDir = dirname(process.execPath);
const claude = Bun.which("claude");
const basePath = `${bunDir}:/usr/bin:/bin`;

function sh(cmd: string[], cwd = clone, env: Record<string, string> = {}): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, { cwd, env: { PATH: basePath, HOME: home, TMPDIR: tmpdir(), ...env } });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

function percentile(sorted: number[], p: number): number {
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! * 10) / 10;
}

/**
 * Runs a plugin's Submit hook command `runs` times, each in a fresh process, as Claude Code runs it, on one Eden
 * home: the first run stores the prompt's rule, the later ones inject it.
 */
function runHook(pluginRoot: string, edenHome: string): HookRuns {
  const command = pluginSubmitCommand(pluginRoot);
  if (!command) throw new Error(`${pluginRoot} registers no UserPromptSubmit hook`);
  rmSync(spawnMarker, { force: true });
  const ms: number[] = [];
  const exitCodes: number[] = [];
  const outputs: string[] = [];
  for (let i = 0; i < runs; i++) {
    const payload = { hook_event_name: "UserPromptSubmit", session_id: "fresh-clone", prompt: PROMPT, cwd: clone };
    const started = performance.now();
    const r = Bun.spawnSync(["/bin/sh", "-c", command], {
      env: {
        PATH: `${stub}:${basePath}`,
        HOME: home,
        TMPDIR: tmpdir(),
        EDEN_HOME: edenHome,
        EDEN_MEMORY_DIR: join(edenHome, "memory"),
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
    });
    ms.push(performance.now() - started);
    exitCodes.push(r.exitCode ?? -1);
    outputs.push(r.stdout.toString());
  }
  ms.sort((a, b) => a - b);
  return {
    exitCodes,
    outputs,
    p50: percentile(ms, 0.5),
    p95: percentile(ms, 0.95),
    spawnedEden: existsSync(spawnMarker),
  };
}

function fallbackLines(edenHome: string): string[] {
  const log = join(edenHome, "plugin-fallback.jsonl");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: Record<string, unknown>) => checks.push({ name, ok, detail });

try {
  const cloned = Bun.spawnSync(["git", "clone", "--quiet", repo, clone]);
  const checkout = Bun.spawnSync(["git", "-C", clone, "checkout", "--quiet", "--detach", sha]);
  if (cloned.exitCode !== 0 || checkout.exitCode !== 0) throw new Error(`cannot clone ${repo} at ${sha}`);
  const plugin = join(clone, "plugins", "eden-memory");

  const noInstallHome = join(tmp, "eden-home-no-install");
  const before = runHook(plugin, noInstallHome);
  const logged = fallbackLines(noInstallHome);
  add(
    "1 fallback before bun install",
    before.exitCodes.every((c) => c === 0) &&
      before.outputs.every((o) => o === "") &&
      !before.spawnedEden &&
      before.p95 <= BUDGET_MS &&
      logged.length === 1,
    {
      p50: before.p50,
      p95: before.p95,
      exitCodes: [...new Set(before.exitCodes)],
      printed: before.outputs.filter(Boolean).length,
      spawnedEden: before.spawnedEden,
      fallbackLines: logged.length,
      cause: logged[0] ? JSON.parse(logged[0]).cause : null,
    },
  );

  const install = sh(["bun", "install", "--frozen-lockfile"]);
  const help = sh(["bun", "packages/cli/src/cli.ts", "--help"]);
  add("2 bun install, CLI loads", install.code === 0 && help.code === 0, {
    install: install.out.split("\n").at(-1),
    cliHelpExit: help.code,
  });

  const inPlaceHome = join(tmp, "eden-home-in-place");
  const inPlace = runHook(plugin, inPlaceHome);
  const packet = inPlace.outputs.at(-1) ?? "";
  add(
    "3 in place, in-process",
    inPlace.exitCodes.every((c) => c === 0) &&
      packet.includes("Eden Memory") &&
      !inPlace.spawnedEden &&
      fallbackLines(inPlaceHome).length === 0 &&
      inPlace.p95 <= BUDGET_MS,
    {
      p50: inPlace.p50,
      p95: inPlace.p95,
      firstOutput: inPlace.outputs[0],
      lastOutput: packet,
      spawnedEden: inPlace.spawnedEden,
      fallbackLines: fallbackLines(inPlaceHome).length,
    },
  );

  if (claude) {
    const claudeEnv = { PATH: `${dirname(claude)}:${basePath}` };
    const market = sh([claude, "plugin", "marketplace", "add", clone], clone, claudeEnv);
    const installed = sh([claude, "plugin", "install", "eden-memory@eden"], clone, claudeEnv);
    const record = JSON.parse(readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8")) as {
      plugins: Record<string, Array<{ installPath: string }>>;
    };
    const copy = record.plugins["eden-memory@eden"]![0]!.installPath;
    const copyHome = join(tmp, "eden-home-installed");
    const fromCopy = runHook(copy, copyHome);
    const sameAsInPlace = fromCopy.outputs.every((o, i) => o === inPlace.outputs[i]);
    add(
      "4 installed copy, in-process",
      market.code === 0 &&
        installed.code === 0 &&
        sameAsInPlace &&
        !fromCopy.spawnedEden &&
        fallbackLines(copyHome).length === 0 &&
        fromCopy.p95 <= BUDGET_MS,
      {
        installPath: copy,
        p50: fromCopy.p50,
        p95: fromCopy.p95,
        sameAsInPlace,
        spawnedEden: fromCopy.spawnedEden,
        fallbackLines: fallbackLines(copyHome).length,
      },
    );
    const doctor = sh(["bun", "packages/cli/src/cli.ts", "doctor", "--memory"], clone, {
      PATH: `${stub}:${basePath}`,
      EDEN_HOME: join(tmp, "eden-home-doctor"),
    });
    add("5 eden doctor --memory", doctor.code === 0, { exit: doctor.code, lines: doctor.out.split("\n") });
  } else {
    add("4 installed copy, in-process", false, { skipped: "claude is not on PATH" });
  }
} catch (err) {
  add("setup", false, { error: (err as Error).message });
} finally {
  if (!args.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
}

const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ ref, sha, runs, budgetMs: BUDGET_MS, dir: tmp, ok, checks }, null, 2));
process.exit(ok ? 0 : 1);
