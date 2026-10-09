/**
 * The checks behind `eden doctor`'s memory section (P0.1): which eden-memory plugin Claude Code runs, whether that
 * copy is current and loads Eden in-process within the Submit budget, what it logged when it could not, and how the
 * store is keyed. Since P0.8, also the delivery-point flags, the circuit breaker and the kill switches (EXECUTION
 * §5). `doctor.ts` assembles them with the hook-registration check.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { findEdenRoot } from "../../../plugins/eden-memory/scripts/eden-root";
import { breakerLine } from "../../../src/memory-breaker";
import {
  breakerPath,
  FLAG_NAMES,
  readBreaker,
  repoFlagsPath,
  repoTop,
  resolveFlags,
  userFlagsPath,
  type BreakerEntry,
  type Flag,
} from "../../../src/memory-flags";
import { fallbackLogPath, readFallbacks } from "../../../plugins/eden-memory/scripts/fallback-log";
import { legacyTree, repoIdentity, repoStoreDir } from "../../../src/memory-repo";
import type { DoctorCheck } from "./doctor";
import { memoryRoot } from "./memory-hook";
import { legacySessions } from "./memory-migrate";
import { edenHome } from "./home";

/** A7 §8, D20: every hook path, Eden's load included, fits in 150 ms on Submit. */
const SUBMIT_BUDGET_MS = 150;
const PROBE_RUNS = 3;
/** The plugin in this checkout, probed when no copy is enabled and no `eden setup` hook is registered. */
const CHECKOUT_PLUGIN = join(import.meta.dir, "../../../plugins/eden-memory");

export type MemoryPlugin = { id: string; installPath: string; version: string; enabled: boolean };

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function readJson(path: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type InstallRecord = { scope?: string; installPath?: string; version?: string; projectPath?: string };

/**
 * The eden-memory plugin Claude Code would run in `cwd`, from `installed_plugins.json`: a project install for `cwd`
 * before a user install. `enabled` layers `enabledPlugins` from user, project and local settings, as Claude Code does.
 */
export function findMemoryPlugin(claudeDir = claudeConfigDir(), cwd = process.cwd()): MemoryPlugin | null {
  const plugins = readJson(join(claudeDir, "plugins", "installed_plugins.json")).plugins;
  const installs = Object.entries(plugins && typeof plugins === "object" ? plugins : {})
    .filter(([id]) => id.startsWith("eden-memory@"))
    .flatMap(([id, records]) => (Array.isArray(records) ? (records as InstallRecord[]) : []).map((r) => ({ id, r })))
    .filter(({ r }) => typeof r.installPath === "string" && (r.scope === "user" || r.projectPath === cwd));
  const pick = installs.find(({ r }) => r.projectPath === cwd) ?? installs[0];
  if (!pick) return null;
  let enabled = false;
  const layers = [
    join(claudeDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  for (const path of layers) {
    const flag = (readJson(path).enabledPlugins as Record<string, unknown> | undefined)?.[pick.id];
    if (typeof flag === "boolean") enabled = flag;
  }
  return { id: pick.id, installPath: pick.r.installPath!, version: String(pick.r.version ?? "?"), enabled };
}

/** The memory events an installed copy's `hooks/hooks.json` registers. */
export function pluginHookEvents(plugin: MemoryPlugin | null): string[] {
  if (!plugin?.enabled) return [];
  const hooks = readJson(join(plugin.installPath, "hooks", "hooks.json")).hooks;
  return hooks && typeof hooks === "object" && !Array.isArray(hooks) ? Object.keys(hooks) : [];
}

/**
 * The shell command a plugin's `hooks/hooks.json` runs on UserPromptSubmit, as Claude Code runs it: `/bin/sh -c`
 * with `CLAUDE_PLUGIN_ROOT` in the environment. Null when the plugin registers none.
 */
export function pluginSubmitCommand(pluginRoot: string): string | null {
  const hooks = readJson(join(pluginRoot, "hooks", "hooks.json")).hooks as Record<string, unknown> | undefined;
  const groups = hooks?.UserPromptSubmit as Array<{ hooks?: Array<{ command?: unknown }> }> | undefined;
  const command = groups?.[0]?.hooks?.[0]?.command;
  return typeof command === "string" ? command : null;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** Files of the checkout's plugin that the installed copy lacks or holds different bytes for. */
function staleFiles(installPath: string, checkoutPlugin: string): string[] {
  return filesUnder(checkoutPlugin)
    .map((path) => relative(checkoutPlugin, path))
    .filter((rel) => {
      const copy = join(installPath, rel);
      return !existsSync(copy) || !readFileSync(copy).equals(readFileSync(join(checkoutPlugin, rel)));
    });
}

const INSTALL_HINT = "claude plugin marketplace add <Eden checkout>, then claude plugin install eden-memory@eden";

/** The plugin directory of the checkout an installed copy runs Eden from, which the copy should equal. */
function checkoutPluginFor(installPath: string): string | null {
  try {
    const dir = join(findEdenRoot(installPath).root, "plugins", "eden-memory");
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** Which plugin Claude Code runs, and whether that copy matches the checkout it runs Eden from. */
export function pluginCheck(plugin: MemoryPlugin | null, hooksFromSettings: boolean): DoctorCheck {
  if (!plugin) {
    return hooksFromSettings
      ? { name: "plugin", ok: true, detail: "not installed · the memory hooks come from eden setup" }
      : { name: "plugin", ok: false, detail: `not installed · ${INSTALL_HINT}` };
  }
  const label = `${plugin.id} ${plugin.version}`;
  if (!plugin.enabled) {
    return { name: "plugin", ok: false, detail: `${label}, disabled · claude plugin enable ${plugin.id}` };
  }
  const checkout = checkoutPluginFor(plugin.installPath);
  if (!checkout) return { name: "plugin", ok: true, detail: `${label}, enabled · no checkout plugin to compare with` };
  const stale = staleFiles(plugin.installPath, checkout);
  if (stale.length) {
    const update = `claude plugin marketplace update, then claude plugin update ${plugin.id}`;
    return {
      name: "plugin",
      ok: false,
      detail: `${label}, enabled · the installed copy differs from ${checkout} (${stale.join(", ")}) · ${update}`,
    };
  }
  return { name: "plugin", ok: true, detail: `${label}, enabled · same as ${checkout}` };
}

type HookProbe = { loaded: boolean; ms: number; cause?: string };

/** A hook that runs longer than this is reported, not waited on. */
const PROBE_TIMEOUT_MS = 10_000;

/** The line of a crash's output that names the error (Bun prints a source excerpt first). */
function errorLine(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim());
  return lines.find((line) => /^(error|[A-Za-z]*Error):/.test(line)) ?? lines[0]!;
}

/**
 * How `hooks/hooks.json` ends each command so that a hook fails open whatever happens, even with no `bun` on PATH:
 * exit 0, and nothing on stderr (EXECUTION §5).
 */
export const FAIL_OPEN_SUFFIX = " 2>/dev/null || true";

/**
 * Runs the plugin's Submit hook command as Claude Code does, in fresh processes with a throwaway Eden home, but
 * without the fail-open suffix, which would hide a crash's stack trace and exit status. Eden loaded in-process when
 * every run exits 0 within the timeout, writes nothing to stderr and logs no fallback. `ms` is the median wall time,
 * shell and process start included.
 */
function probePluginHook(pluginRoot: string, hookCommand: string): HookProbe {
  const command = hookCommand.endsWith(FAIL_OPEN_SUFFIX) ? hookCommand.slice(0, -FAIL_OPEN_SUFFIX.length) : hookCommand;
  const home = mkdtempSync(join(tmpdir(), "eden-doctor-probe-"));
  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      HOME: home,
      EDEN_HOME: join(home, ".eden"),
      EDEN_MEMORY_DIR: join(home, ".eden", "memory"),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    };
    if (process.env.EDEN_ROOT) env.EDEN_ROOT = process.env.EDEN_ROOT;
    const payload = { hook_event_name: "UserPromptSubmit", session_id: "eden-doctor", prompt: "probe", cwd: home };
    const times: number[] = [];
    let failure: string | undefined;
    for (let i = 0; i < PROBE_RUNS && !failure; i++) {
      const started = performance.now();
      const run = Bun.spawnSync(["/bin/sh", "-c", command], {
        env,
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: "ignore",
        stderr: "pipe",
        timeout: PROBE_TIMEOUT_MS,
      });
      times.push(performance.now() - started);
      const stderr = run.stderr.toString().trim();
      if (run.exitedDueToTimeout) failure = `the hook ran over ${PROBE_TIMEOUT_MS / 1000} s`;
      else if (stderr) failure = `the hook wrote to stderr: ${errorLine(stderr)}`;
      else if (run.exitCode !== 0) failure = `the hook exited ${run.exitCode}`;
    }
    const cause = readFallbacks(fallbackLogPath(join(home, ".eden")))[0]?.cause ?? failure;
    const ms = Math.round(times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!);
    return cause ? { loaded: false, ms, cause } : { loaded: true, ms };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Whether `dir` is an eden-memory plugin directory (its manifest says so). */
function isMemoryPlugin(dir: string): boolean {
  return readJson(join(dir, ".claude-plugin", "plugin.json")).name === "eden-memory";
}

type ModulesCheck = { check: DoctorCheck; loaded: boolean };

const modulesLine = (ok: boolean, detail: string, loaded = ok): ModulesCheck => ({
  loaded,
  check: { name: "modules", ok, detail },
});

/**
 * Whether the hook Claude Code runs loads Eden in-process, from which checkout, and within the Submit budget. With no
 * plugin enabled, `eden setup`'s hooks run the CLI itself (nothing to probe); otherwise this checkout's plugin is
 * probed, to show whether installing it would work.
 */
export function modulesCheck(plugin: MemoryPlugin | null, hooksFromSettings: boolean): ModulesCheck {
  if (!plugin?.enabled && hooksFromSettings) {
    return modulesLine(true, "not probed · the memory hooks come from eden setup, which runs the CLI", false);
  }
  const installed = plugin?.enabled === true;
  const pluginRoot = installed ? plugin.installPath : CHECKOUT_PLUGIN;
  if (!installed && !isMemoryPlugin(pluginRoot)) {
    return modulesLine(
      false,
      "nothing to probe · no eden-memory plugin enabled, and this CLI is not in an Eden checkout",
    );
  }
  if (!Bun.which("bun")) return modulesLine(false, "bun is not on PATH · the hooks run bun");
  const command = pluginSubmitCommand(pluginRoot);
  if (!command) return modulesLine(false, `${pluginRoot}/hooks/hooks.json registers no UserPromptSubmit hook`);
  let where: string;
  try {
    const { root, via } = findEdenRoot(pluginRoot);
    where = `${installed ? "" : "this checkout's plugin (none enabled): "}${root} (${via})`;
  } catch (err) {
    return modulesLine(false, (err as Error).message);
  }
  if (!existsSync(join(pluginRoot, "scripts", "fallback-log.ts"))) {
    // A hook from before P0.1 falls back silently, to hookd or to a 2.6 s `eden hook` spawn: a clean probe proves
    // nothing about it.
    const update = `claude plugin update ${plugin?.id ?? "eden-memory@eden"}`;
    return modulesLine(
      false,
      `${where} · this hook does not log its fallbacks, so whether it loads Eden is unknown · ${update}`,
    );
  }
  const probe = probePluginHook(pluginRoot, command);
  if (!probe.loaded) return modulesLine(false, `${where} · cannot load: ${probe.cause}`);
  const inBudget = probe.ms <= SUBMIT_BUDGET_MS;
  const timing = inBudget
    ? `in-process in ${probe.ms} ms (budget ${SUBMIT_BUDGET_MS} ms)`
    : `in-process in ${probe.ms} ms, over the ${SUBMIT_BUDGET_MS} ms budget`;
  return modulesLine(inBudget, `${where} · the hook loads Eden ${timing}`, true);
}

/** What the plugin logged when it could not run Eden. A logged cause is fine once the hook loads again. */
export function fallbackCheck(loadsNow: boolean, path = fallbackLogPath(edenHome())): DoctorCheck {
  const causes = new Map(readFallbacks(path).map((f) => [`${f.plugin}\n${f.cause}`, f]));
  if (!causes.size) return { name: "fallback", ok: true, detail: "none logged" };
  const last = [...causes.values()].at(-1)!;
  const count = `${causes.size} cause${causes.size === 1 ? "" : "s"} logged`;
  const now = loadsNow ? " · the hook loads now" : "";
  return { name: "fallback", ok: loadsNow, detail: `${count}, last ${last.t}: ${last.cause}${now} · ${path}` };
}

/** How the store is keyed (D1). Folder scopes (D3) and the policy guard (D18) come in later slices. */
export function storeChecks(cwd = process.cwd()): DoctorCheck[] {
  return [
    repoKeyCheck(memoryRoot(), cwd),
    { name: "scope catalog", ok: true, detail: "none · no folder scopes" },
    { name: "guard", ok: true, detail: "off · no PreToolUse policy guard" },
  ];
}

/**
 * The repo a session in `cwd` remembers in (D1): its key and store, and the stores of the per-session layout before
 * P0.5 that `eden memory migrate` has not moved yet.
 */
export function repoKeyCheck(root: string, cwd: string): DoctorCheck {
  const repo = repoIdentity(cwd);
  if (!repo) return { name: "repo key", ok: true, detail: `none · ${cwd} is not an absolute path` };
  const of = repo.top ? `the repo at ${repo.top}` : `${cwd}, outside git (a session keeps the folder it starts in)`;
  const legacy = existsSync(legacyTree(root)) ? [] : legacySessions(root);
  const waiting = legacy.length
    ? ` · ${legacy.length} per-session stores from before per-repo memory: eden memory migrate --dry-run`
    : "";
  return { name: "repo key", ok: true, detail: `${repo.key} · ${repoStoreDir(root, repo.key)}, for ${of}${waiting}` };
}

/**
 * The delivery-point flags (X7) as the next event in `cwd` resolves them, each with its source. An unknown value is
 * named: it resolves to `off` (`shadow` for `deliver.submit`), which may not be what was meant.
 */
export function flagsCheck(cwd = process.cwd()): DoctorCheck {
  const state = resolveFlags(cwd);
  const unknown = FLAG_NAMES.filter((flag) => state[flag].unknown !== undefined);
  const parts = FLAG_NAMES.map((flag) => {
    const { mode, source, unknown: raw } = state[flag];
    return `${flag} ${mode} (${source}${raw === undefined ? "" : `: unknown value ${JSON.stringify(raw)}`})`;
  });
  return { name: "flags", ok: unknown.length === 0, detail: parts.join(" · ") };
}

/** The points the circuit breaker holds in shadow (EXECUTION §5). */
export function breakerCheck(): DoctorCheck {
  const forced = Object.entries(readBreaker()) as [Flag, BreakerEntry][];
  if (!forced.length) return { name: "breaker", ok: true, detail: `none tripped · ${breakerPath()}` };
  const lines = forced.map(([point, entry]) => breakerLine(point, entry));
  const fix = "a stage evaluation (/next stages) that shows the cause is fixed turns a point back on early";
  return { name: "breaker", ok: false, detail: `${lines.join(" · ")} · ${fix} · ${breakerPath()}` };
}

/** EXECUTION §5's kill switches, narrowest first. */
export function killSwitchesCheck(cwd = process.cwd()): DoctorCheck {
  const top = repoTop(cwd);
  // X7's precedence: the repo file beats the user file, so in a repo whose file sets a point, only it turns it off.
  const files = top ? `${repoFlagsPath(top)} (wins in this repo) or ${userFlagsPath()}` : userFlagsPath();
  const switches = [
    `1. a point's flag set to off in ${files}, from the next event; an EDEN_FLAG_* variable beats both`,
    "2. EDEN_MEMORY=off in Claude Code's environment (from the next session)",
    '3. claude plugin disable eden-memory@eden, or "disableAllHooks": true in Claude Code settings',
  ];
  return { name: "kill switches", ok: true, detail: switches.join(" · ") };
}
