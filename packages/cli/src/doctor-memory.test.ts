/**
 * P0.1: `eden doctor --memory` says whether Eden memory works in this install: the memory hooks are registered, the
 * installed plugin is current and loads Eden in-process within the Submit budget, and what it has logged. Run as a
 * process against a Claude config dir laid out as `/plugin install eden-memory@eden` leaves it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoIdentity, repoStoreDir } from "../../../src/memory-repo";
import { repoKeyCheck } from "./doctor-memory";

const REPO = join(import.meta.dir, "../../..");
const CLI = join(REPO, "packages", "cli", "src", "cli.ts");
const PLUGIN_ID = "eden-memory@eden";

const tmp = mkdtempSync(join(tmpdir(), "eden-doctor-memory-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let homes = 0;

type Install = { marketplace?: string; enabled?: boolean; edit?: (copy: string) => void };

/** A fresh HOME whose `.claude` holds the plugin installed from `marketplace` (none when `install` is null). */
function homeWith(install: Install | null): string {
  const home = join(tmp, `home-${++homes}`);
  const plugins = join(home, ".claude", "plugins");
  mkdirSync(plugins, { recursive: true });
  if (!install) return home;
  const marketplace = install.marketplace ?? REPO;
  const copy = join(plugins, "cache", "eden", "eden-memory", "0.2.0");
  cpSync(join(REPO, "plugins", "eden-memory"), copy, { recursive: true });
  install.edit?.(copy);
  const entry = { scope: "user", installPath: copy, version: "0.2.0" };
  writeFileSync(
    join(plugins, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [entry] } }),
  );
  const source = { source: "directory", path: marketplace };
  writeFileSync(
    join(plugins, "known_marketplaces.json"),
    JSON.stringify({ eden: { source, installLocation: marketplace } }),
  );
  const settings = { enabledPlugins: { [PLUGIN_ID]: install.enabled ?? true } };
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
  return home;
}

async function doctorMemory(home: string): Promise<{ code: number; lines: Map<string, string> }> {
  const proc = Bun.spawn(["bun", CLI, "doctor", "--memory"], {
    cwd: home,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: tmpdir(),
      EDEN_HOME: join(home, ".eden"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const lines = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const m = /^(ok|!!) {2}([^:]+): (.*)$/.exec(line);
    if (m) lines.set(m[2]!, `${m[1]} ${m[3]}`);
  }
  return { code, lines };
}

const SECTION = [
  "memory",
  "plugin",
  "modules",
  "fallback",
  "repo key",
  "scope catalog",
  "guard",
  "flags",
  "breaker",
  "kill switches",
];

describe("eden doctor --memory", () => {
  test("the plugin installed from this checkout: every line ok, exit 0", async () => {
    const { code, lines } = await doctorMemory(homeWith({}));
    expect([...lines.keys()]).toEqual(SECTION);
    for (const name of SECTION.filter((n) => n !== "modules")) expect(lines.get(name)).toStartWith("ok ");
    expect(lines.get("memory")).toContain("UserPromptSubmit");
    expect(lines.get("plugin")).toContain(PLUGIN_ID);
    expect(lines.get("fallback")).toBe("ok none logged");
    // The probe's timing decides the modules verdict; a slow machine (a loaded CI runner) is over budget.
    const modules = lines.get("modules")!;
    expect(modules).toContain(REPO);
    const ms = Number(/in-process in (\d+) ms/.exec(modules)?.[1]);
    const inBudget = ms <= 150;
    expect(modules).toEndWith(inBudget ? `in ${ms} ms (budget 150 ms)` : `in ${ms} ms, over the 150 ms budget`);
    expect(modules).toStartWith(inBudget ? "ok " : "!! ");
    expect(code).toBe(inBudget ? 0 : 1);
  });

  test("nothing installed: the hooks line says how to install, exit 1", async () => {
    const { code, lines } = await doctorMemory(homeWith(null));
    expect(lines.get("memory")).toStartWith("!! memory hooks: none");
    expect(lines.get("plugin")).toStartWith("!! not installed");
    expect(code).toBe(1);
  });

  test("a disabled plugin registers no hook", async () => {
    const { code, lines } = await doctorMemory(homeWith({ enabled: false }));
    expect(lines.get("memory")).toStartWith("!! memory hooks: none");
    expect(lines.get("plugin")).toContain("disabled");
    expect(code).toBe(1);
  });

  test("Eden cannot load from the installed copy: modules names the cause, exit 1", async () => {
    const bare = join(tmp, `bare-${++homes}`);
    const hook = join(bare, "packages", "cli", "src", "memory-hook.ts");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, 'export { redact as runMemoryHookStdin } from "@eden/not-installed";\n');
    const { code, lines } = await doctorMemory(homeWith({ marketplace: bare }));
    expect(lines.get("modules")).toStartWith("!! ");
    expect(lines.get("modules")).toContain("@eden/not-installed");
    expect(code).toBe(1);
  });

  test("an installed copy older than the checkout is named, exit 1", async () => {
    const stale = (copy: string) => writeFileSync(join(copy, "scripts", "hook.ts"), "// an older hook\n");
    const { code, lines } = await doctorMemory(homeWith({ edit: stale }));
    expect(lines.get("plugin")).toStartWith("!! ");
    expect(lines.get("plugin")).toContain("claude plugin update eden-memory@eden");
    expect(code).toBe(1);
  });

  test("a copy from before P0.1, which cannot log a fallback, is not vouched for", async () => {
    const old = (copy: string) => rmSync(join(copy, "scripts", "fallback-log.ts"));
    const { code, lines } = await doctorMemory(homeWith({ edit: old }));
    expect(lines.get("modules")).toStartWith("!! ");
    expect(lines.get("modules")).toContain("does not log its fallbacks");
    expect(code).toBe(1);
  });

  test("a hook that crashes before it loads Eden is not vouched for, though hooks.json silences it", async () => {
    const crash = (copy: string) => {
      const hook = join(copy, "scripts", "hook.ts");
      const [shebang, ...rest] = readFileSync(hook, "utf8").split("\n");
      writeFileSync(hook, [shebang, 'throw new Error("boom before Eden loads");', ...rest].join("\n"));
    };
    const { code, lines } = await doctorMemory(homeWith({ edit: crash }));
    expect(lines.get("modules")).toStartWith("!! ");
    expect(lines.get("modules")).toContain("the hook wrote to stderr");
    expect(lines.get("modules")).toContain("boom before Eden loads");
    expect(code).toBe(1);
  });

  test("hooks from eden setup: modules says there is no plugin to probe", async () => {
    const home = homeWith(null);
    const setupHook = { hooks: [{ type: "command", command: "eden hook" }] };
    const events = ["UserPromptSubmit", "SessionStart", "PreCompact", "Stop", "SessionEnd", "PostToolUse"];
    const hooks = Object.fromEntries([...events, "SubagentStop"].map((event) => [event, [setupHook]]));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks }));
    const { code, lines } = await doctorMemory(home);
    expect(lines.get("memory")).toStartWith("ok memory hooks: UserPromptSubmit");
    expect(lines.get("plugin")).toBe("ok not installed · the memory hooks come from eden setup");
    expect(lines.get("modules")).toStartWith("ok not probed");
    expect(code).toBe(0);
  });

  test("a fallback the hook logged shows, with its cause", async () => {
    const home = homeWith({});
    mkdirSync(join(home, ".eden"), { recursive: true });
    const line = { t: "2026-10-05T12:00:00.000Z", plugin: "/old/copy", cause: "Cannot find package '@eden/ir'" };
    writeFileSync(join(home, ".eden", "plugin-fallback.jsonl"), `${JSON.stringify(line)}\n`);
    const { lines } = await doctorMemory(home);
    expect(lines.get("fallback")).toContain("1 cause logged");
    expect(lines.get("fallback")).toContain("Cannot find package '@eden/ir'");
  });

  test("the flags line resolves every delivery point with its source; the kill switches are listed", async () => {
    const { lines } = await doctorMemory(homeWith({}));
    expect(lines.get("flags")).toStartWith("ok deliver.submit on (default) · deliver.session_start on (default)");
    expect(lines.get("flags")).toContain("guard.ask off (default)");
    expect(lines.get("breaker")).toStartWith("ok none tripped");
    const kill = lines.get("kill switches")!;
    expect(kill).toContain("1. a point's flag set to off in");
    expect(kill).toContain("2. EDEN_MEMORY=off");
    expect(kill).toContain("3. claude plugin disable eden-memory@eden");
  });

  test("an unknown flag value and a tripped breaker are named, exit 1", async () => {
    const home = homeWith({});
    mkdirSync(join(home, ".eden"), { recursive: true });
    writeFileSync(join(home, ".eden", "flags.json"), JSON.stringify({ "deliver.submit": "yes" }));
    const until = Date.now() + 3_600_000;
    const entry = { mode: "shadow", since: Date.now(), until, cause: "1 unhandled exception", announced: true };
    writeFileSync(join(home, ".eden", "flags.auto.json"), JSON.stringify({ "deliver.session_start": entry }));
    const { code, lines } = await doctorMemory(home);
    expect(lines.get("flags")).toStartWith('!! deliver.submit shadow (user: unknown value "yes")');
    expect(lines.get("flags")).toContain("deliver.session_start shadow (breaker)");
    expect(lines.get("breaker")).toStartWith(
      "!! SessionStart delivery (deliver.session_start) is in shadow mode until",
    );
    expect(lines.get("breaker")).toContain("/next stages");
    expect(code).toBe(1);
  });
});

describe("repo key (D1)", () => {
  test("names the repo's key and store, and the per-session stores still to migrate", () => {
    const base = mkdtempSync(join(tmpdir(), "eden-doctor-repo-"));
    try {
      const top = join(base, "app");
      mkdirSync(join(top, "src"), { recursive: true });
      Bun.spawnSync(["git", "init", "-q", top]);
      const root = join(base, "memory");
      const key = repoIdentity(top)!.key;
      const line = repoKeyCheck(root, join(top, "src"));
      expect(line).toEqual({
        name: "repo key",
        ok: true,
        detail: `${key} · ${repoStoreDir(root, key)}, for the repo at ${top}`,
      });
      mkdirSync(join(root, "8f0c2a4e-1b3d-4c5e-9f7a-0b1c2d3e4f5a"), { recursive: true });
      expect(repoKeyCheck(root, top).detail).toEndWith(
        " · 1 per-session stores from before per-repo memory: eden memory migrate --dry-run",
      );
      expect(repoKeyCheck(root, base).detail).toContain(`, for ${base}, outside git`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
