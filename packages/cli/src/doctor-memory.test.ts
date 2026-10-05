/**
 * P0.1: `eden doctor --memory` says whether Eden memory works in this install: the memory hooks are registered, the
 * installed plugin is current and loads Eden in-process within the Submit budget, and what it has logged. Run as a
 * process against a Claude config dir laid out as `/plugin install eden-memory@eden` leaves it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

const SECTION = ["memory", "plugin", "modules", "fallback", "repo key", "scope catalog", "guard"];

describe("eden doctor --memory", () => {
  test("the plugin installed from this checkout: every line ok, exit 0", async () => {
    const { code, lines } = await doctorMemory(homeWith({}));
    expect([...lines.keys()]).toEqual(SECTION);
    for (const name of SECTION) expect(lines.get(name)).toStartWith("ok ");
    expect(lines.get("memory")).toContain("UserPromptSubmit");
    expect(lines.get("plugin")).toContain(PLUGIN_ID);
    expect(lines.get("modules")).toContain(REPO);
    expect(lines.get("modules")).toMatch(/in-process in \d+ ms \(budget 150 ms\)/);
    expect(lines.get("fallback")).toBe("ok none logged");
    expect(code).toBe(0);
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

  test("a fallback the hook logged shows, with its cause", async () => {
    const home = homeWith({});
    mkdirSync(join(home, ".eden"), { recursive: true });
    const line = { t: "2026-10-05T12:00:00.000Z", plugin: "/old/copy", cause: "Cannot find package '@eden/ir'" };
    writeFileSync(join(home, ".eden", "plugin-fallback.jsonl"), `${JSON.stringify(line)}\n`);
    const { lines } = await doctorMemory(home);
    expect(lines.get("fallback")).toContain("1 cause logged");
    expect(lines.get("fallback")).toContain("Cannot find package '@eden/ir'");
  });
});
