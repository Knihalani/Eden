import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The MCP-only installer (examples/mcp-agents/install.py) merges one `eden` server entry into each
// MCP-capable agent's config — JSON, YAML and TOML. These exercise every merge format against fake
// configs without touching a real home.

const python = Bun.which("python3");
const script = resolve(import.meta.dir, "install.py");

const run = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync([python!, script, ...args], {
    env: { PATH: process.env.PATH!, HOME: "/nonexistent", ...env },
    stderr: "pipe",
  });

const dir = (base: string, rel: string) => {
  const p = join(base, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  return p;
};

describe.skipIf(!python)("the MCP-only installer", () => {
  test("merges JSON (mcpServers/mcp/context_servers), Goose YAML and Codex TOML; reinstall dedupes; uninstall removes", () => {
    const base = mkdtempSync(join(tmpdir(), "eden-mcp-agents-"));
    const cline = dir(base, "cline/settings.json");
    writeFileSync(cline, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const zed = dir(base, "zed/settings.json");
    writeFileSync(zed, '{ // zed accepts comments\n  "context_servers": {}}');
    const goose = dir(base, "goose/config.yaml");
    writeFileSync(goose, "GOOSE_PROVIDER: anthropic\nextensions:\n  developer:\n    type: builtin\n");
    const codex = dir(base, "codex/config.toml");
    writeFileSync(codex, '[profile.default]\nregion = "x"\n\n[mcp_servers.eden]\ncommand = "old"\n');
    const out = run(
      [
        "--eden-home",
        join(base, "eh"),
        "--cline-config",
        cline,
        "--zed-config",
        zed,
        "--goose-config",
        goose,
        "--codex-config",
        codex,
        "--agents",
        "cline,zed,goose,codex",
        "--remote",
      ],
      { EDEN_URL: "https://e", EDEN_API_KEY: "k9" },
    );
    expect(out.exitCode, out.stderr.toString()).toBe(0);

    const c = JSON.parse(readFileSync(cline, "utf8"));
    expect(c.mcpServers.eden.command).toBe("python3");
    expect(c.mcpServers.eden.env).toEqual({ EDEN_URL: "https://e", EDEN_API_KEY: "k9" });
    expect(c.mcpServers.other).toEqual({ command: "x" });

    const z = JSON.parse(readFileSync(zed, "utf8"));
    expect(z.context_servers.eden.command.path).toBe("python3");
    expect(z.context_servers.eden.command.env.EDEN_API_KEY).toBe("k9");

    const g = readFileSync(goose, "utf8");
    expect(g).toContain("  eden:\n    type: stdio");
    expect(g).toContain("  developer:\n    type: builtin");
    expect(g).toContain("      EDEN_API_KEY: k9");

    const x = readFileSync(codex, "utf8");
    expect(x).toContain("[profile.default]");
    expect(x).toContain("[mcp_servers.eden]");
    expect(x).toContain('command = "python3"');
    expect(x).not.toContain('command = "old"');
    expect(x).toContain('EDEN_API_KEY = "k9"');

    // reinstall replaces, never duplicates
    const again = run(
      [
        "--eden-home",
        join(base, "eh"),
        "--goose-config",
        goose,
        "--codex-config",
        codex,
        "--agents",
        "goose,codex",
        "--remote",
      ],
      { EDEN_URL: "https://e", EDEN_API_KEY: "k9" },
    );
    expect(again.exitCode, again.stderr.toString()).toBe(0);
    expect(readFileSync(goose, "utf8").split("eden:").length - 1).toBe(1);
    expect(readFileSync(codex, "utf8").split("[mcp_servers.eden]").length - 1).toBe(1);

    const gone = run(["--cline-config", cline, "--agents", "cline", "--uninstall"]);
    expect(gone.exitCode, gone.stderr.toString()).toBe(0);
    const after = JSON.parse(readFileSync(cline, "utf8"));
    expect(after.mcpServers.eden).toBeUndefined();
    expect(after.mcpServers.other).toEqual({ command: "x" });

    // Continue drops its own file under mcpServers/ — written, then removed whole
    const cont = join(base, "cont", "mcpServers", "eden.json");
    const ci = run(["--continue-config", cont, "--agents", "continue", "--remote", "--eden-home", join(base, "eh")], {
      EDEN_URL: "https://e",
      EDEN_API_KEY: "k9",
    });
    expect(ci.exitCode, ci.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(cont, "utf8")).mcpServers.eden.env.EDEN_API_KEY).toBe("k9");
    const cu = run(["--continue-config", cont, "--agents", "continue", "--uninstall", "--eden-home", join(base, "eh")]);
    expect(cu.exitCode, cu.stderr.toString()).toBe(0);
    expect(existsSync(cont)).toBe(false);
  });

  test("--list reports each agent's detection, and a config that isn't JSON is warned, not clobbered", () => {
    const base = mkdtempSync(join(tmpdir(), "eden-mcp-agents-"));
    const listed = run(["--list"], { HOME: base });
    for (const name of [
      "cline",
      "roo-code",
      "amazon-q",
      "crush",
      "zed",
      "goose",
      "codex",
      "kiro",
      "warp",
      "continue",
    ]) {
      expect(listed.stdout.toString()).toContain(name);
    }
    const bad = dir(base, "c/settings.json");
    writeFileSync(bad, "not json at all {{{");
    const out = run(["--cline-config", bad, "--agents", "cline", "--eden-home", join(base, "eh"), "--remote"], {
      EDEN_URL: "https://e",
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr.toString()).toContain("not a JSON object");
    expect(readFileSync(bad, "utf8")).toBe("not json at all {{{");
  });
});
