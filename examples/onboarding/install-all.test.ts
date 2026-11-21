import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The unified installer (examples/install.py) detects which agent homes exist and delegates each to that
// agent's own install.py. These exercise its detection and selection without running any real install.

const python = Bun.which("python3");
const script = resolve(import.meta.dir, "../install.py");

const run = (args: string[], home: string) =>
  Bun.spawnSync([python!, script, ...args], {
    env: { PATH: process.env.PATH!, HOME: home, USERPROFILE: home },
    stderr: "pipe",
  });

describe.skipIf(!python)("the unified installer", () => {
  test("detects the agent homes present and reports the absent ones", () => {
    const home = mkdtempSync(join(tmpdir(), "eden-install-all-"));
    mkdirSync(join(home, ".pi"));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const out = run(["--list"], home);
    expect(out.exitCode, out.stderr.toString()).toBe(0);
    const text = out.stdout.toString();
    for (const name of [
      "claude-code",
      "cursor",
      "devin-cli",
      "gemini-cli",
      "gptme",
      "openclaw",
      "opencode",
      "pi",
      "qwen-code",
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toMatch(/pi\s+detected/);
    expect(text).toMatch(/opencode\s+detected/);
    expect(text).toMatch(/claude-code\s+home absent/);
    expect(text).toMatch(/cursor\s+home absent/);
    expect(text).toMatch(/qwen-code\s+home absent/);
    expect(text).toMatch(/devin-cli\s+home absent/);
    expect(text).toMatch(/gemini-cli\s+home absent/);
    expect(text).toMatch(/openclaw\s+home absent/);
  });

  test("--agents selects absent homes too, and rejects names it does not know", () => {
    const home = mkdtempSync(join(tmpdir(), "eden-install-all-"));
    const dry = run(["--agents", "pi,opencode", "--dry-run"], home);
    expect(dry.exitCode, dry.stderr.toString()).toBe(0);
    expect(dry.stdout.toString()).toContain("examples/pi/install.py");
    expect(dry.stdout.toString()).toContain("examples/opencode/install.py");
    expect(dry.stdout.toString()).not.toContain("gptme");
    const bad = run(["--agents", "not-an-agent"], home);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr.toString()).toContain("not-an-agent");
  });

  test("each agent's own home flag is forwarded, and --list shows an override's path", () => {
    const home = mkdtempSync(join(tmpdir(), "eden-install-all-"));
    const dry = run(["--claude-code-home", "/opt/cc", "--dry-run"], home);
    // claude-code's installer takes --claude-home, not --claude-code-home.
    expect(dry.stdout.toString()).toContain("claude-code/install.py --claude-home /opt/cc");
    const listed = run(["--list", "--pi-home", "/work/pi"], home);
    expect(listed.stdout.toString()).toContain("/work/pi");
  });
});
