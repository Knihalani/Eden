/**
 * The checks behind `eden doctor`'s memory section (P0.1): which eden-memory plugin Claude Code runs, whether that
 * copy is current and loads Eden in-process within the Submit budget, what it logged when it could not, and how the
 * store is keyed. `doctor.ts` assembles them with the hook-registration check.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { findEdenRoot } from "../../../plugins/eden-memory/scripts/eden-root";
import { fallbackLogPath, readFallbacks } from "../../../plugins/eden-memory/scripts/fallback-log";
import type { DoctorCheck } from "./doctor";
import { edenHome } from "./home";

/** A7 §8, D20: every hook path, Eden's load included, fits in 150 ms on Submit. */
const SUBMIT_BUDGET_MS = 150;
const PROBE_RUNS = 3;
/** The plugin in this checkout, whose hook is probed when no installed copy is enabled. */
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

/**
 * Runs the plugin's hook as Claude Code does, on a Submit, in fresh processes with a throwaway Eden home: Eden loaded
 * in-process when every run exits 0 and none logged a fallback. `ms` is the median wall time, process start included.
 */
function probePluginHook(pluginRoot: string, bun: string): HookProbe {
  const home = mkdtempSync(join(tmpdir(), "eden-doctor-probe-"));
  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      HOME: home,
      EDEN_HOME: join(home, ".eden"),
      EDEN_MEMORY_DIR: join(home, ".eden", "memory"),
    };
    if (process.env.EDEN_ROOT) env.EDEN_ROOT = process.env.EDEN_ROOT;
    const payload = { hook_event_name: "UserPromptSubmit", session_id: "eden-doctor", prompt: "probe", cwd: home };
    const times: number[] = [];
    let exitedZero = true;
    for (let i = 0; i < PROBE_RUNS; i++) {
      const started = performance.now();
      const run = Bun.spawnSync([bun, join(pluginRoot, "scripts", "hook.ts")], {
        env,
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: "ignore",
        stderr: "ignore",
      });
      times.push(performance.now() - started);
      exitedZero &&= run.exitCode === 0;
    }
    const cause = readFallbacks(fallbackLogPath(join(home, ".eden")))[0]?.cause;
    const ms = Math.round(times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!);
    return cause || !exitedZero
      ? { loaded: false, ms, cause: cause ?? "the hook exited non-zero" }
      : { loaded: true, ms };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Whether the hook Claude Code runs loads Eden in-process, from which checkout, and within the Submit budget. */
export function modulesCheck(plugin: MemoryPlugin | null): { check: DoctorCheck; loaded: boolean } {
  const pluginRoot = plugin?.enabled ? plugin.installPath : CHECKOUT_PLUGIN;
  const bun = Bun.which("bun");
  if (!bun) {
    return { loaded: false, check: { name: "modules", ok: false, detail: "bun is not on PATH · the hooks run bun" } };
  }
  let where: string;
  try {
    const { root, via } = findEdenRoot(pluginRoot);
    where = `${root} (${via})`;
  } catch (err) {
    return { loaded: false, check: { name: "modules", ok: false, detail: (err as Error).message } };
  }
  if (!existsSync(join(pluginRoot, "scripts", "fallback-log.ts"))) {
    // A hook from before P0.1 falls back silently, to hookd or to a 2.6 s `eden hook` spawn: a clean probe proves
    // nothing about it.
    const update = `claude plugin update ${plugin?.id ?? "eden-memory@eden"}`;
    const detail = `${where} · this hook does not log its fallbacks, so whether it loads Eden is unknown · ${update}`;
    return { loaded: false, check: { name: "modules", ok: false, detail } };
  }
  const probe = probePluginHook(pluginRoot, bun);
  if (!probe.loaded) {
    return { loaded: false, check: { name: "modules", ok: false, detail: `${where} · cannot load: ${probe.cause}` } };
  }
  const inBudget = probe.ms <= SUBMIT_BUDGET_MS;
  const timing = inBudget
    ? `in-process in ${probe.ms} ms (budget ${SUBMIT_BUDGET_MS} ms)`
    : `in-process in ${probe.ms} ms, over the ${SUBMIT_BUDGET_MS} ms budget`;
  return { loaded: true, check: { name: "modules", ok: inBudget, detail: `${where} · the hook loads Eden ${timing}` } };
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

/** How the store is keyed today. Repo keys (D1), folder scopes (D3) and the policy guard (D18) come in later slices. */
export function storeChecks(): DoctorCheck[] {
  const dir = process.env.EDEN_MEMORY_DIR || join(edenHome(), "memory");
  return [
    { name: "repo key", ok: true, detail: `none · memory is kept per Claude session, in ${dir}` },
    { name: "scope catalog", ok: true, detail: "none · no folder scopes" },
    { name: "guard", ok: true, detail: "off · no PreToolUse policy guard" },
  ];
}
