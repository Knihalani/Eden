import { describe, expect, test } from "bun:test";
import { tmpDir } from "../../packages/primitives/src/tmpdir";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    const base = tmpDir("eden-mcp-agents-");
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
    const base = tmpDir("eden-mcp-agents-");
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
      "kilo-code",
      "vscode",
      "junie",
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

  test("Goose indents/comments, Continue preserves other servers, Codex drops env subtables, remote env rides, modes stay 0600", () => {
    const base = tmpDir("eden-mcp-agents-");
    const env = { EDEN_URL: "https://e", EDEN_API_KEY: "k9", EDEN_USER_ID: "u1", EDEN_TENANT_ID: "t1" };

    // Goose: a comment may trail `extensions:` and children may sit at four spaces — the sibling
    // must stay a sibling (not nested under eden) and eden must adopt the file's indent.
    const goose = dir(base, "g/config.yaml");
    writeFileSync(goose, "extensions: # managed\n    developer:\n      type: builtin\n");
    const r = run(["--goose-config", goose, "--agents", "goose", "--remote", "--eden-home", join(base, "eh")], env);
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const g = readFileSync(goose, "utf8");
    expect(g).toContain("    eden:\n      type: stdio");
    expect(g).toContain("    developer:\n      type: builtin");
    expect(g).toContain("EDEN_USER_ID: u1");
    expect(g).toContain("EDEN_TENANT_ID: t1");
    expect(g.split("eden:").length - 1).toBe(1);

    // Continue: a --continue-config holding other servers is merged, and uninstall keeps them.
    const cont = dir(base, "cont/mcpServers/eden.json");
    writeFileSync(cont, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const ci = run(
      ["--continue-config", cont, "--agents", "continue", "--remote", "--eden-home", join(base, "eh")],
      env,
    );
    expect(ci.exitCode, ci.stderr.toString()).toBe(0);
    const cd = JSON.parse(readFileSync(cont, "utf8"));
    expect(cd.mcpServers.other).toEqual({ command: "x" });
    expect(cd.mcpServers.eden.env.EDEN_USER_ID).toBe("u1");
    const cu = run(["--continue-config", cont, "--agents", "continue", "--uninstall", "--eden-home", join(base, "eh")]);
    expect(cu.exitCode, cu.stderr.toString()).toBe(0);
    const ca = JSON.parse(readFileSync(cont, "utf8"));
    expect(ca.mcpServers.other).toEqual({ command: "x" });
    expect(ca.mcpServers.eden).toBeUndefined();

    // Codex: a legacy [mcp_servers.eden.env] subtable must not survive a reinstall.
    const codex = dir(base, "x/config.toml");
    writeFileSync(codex, '[mcp_servers.eden]\ncommand = "old"\n\n[mcp_servers.eden.env]\nEDEN_URL = "stale"\n');
    const xr = run(["--codex-config", codex, "--agents", "codex", "--remote", "--eden-home", join(base, "eh")], env);
    expect(xr.exitCode, xr.stderr.toString()).toBe(0);
    const x = readFileSync(codex, "utf8");
    expect(x).not.toContain("[mcp_servers.eden.env]");
    expect(x).not.toContain("stale");
    expect(x.split("[mcp_servers.eden]").length - 1).toBe(1);
    expect(x).toContain('EDEN_USER_ID = "u1"');

    // Kilo Code (JSONC): the mcp table gets a "local" entry with a command array + environment.
    const kilo = dir(base, "kilo/kilo.jsonc");
    writeFileSync(kilo, '{ // kilo is jsonc\n  "mcp": {},\n}\n');
    const kr = run(
      ["--kilo-code-config", kilo, "--agents", "kilo-code", "--remote", "--eden-home", join(base, "eh")],
      env,
    );
    expect(kr.exitCode, kr.stderr.toString()).toBe(0);
    const k = JSON.parse(readFileSync(kilo, "utf8"));
    expect(k.mcp.eden).toEqual({
      type: "local",
      command: ["python3", expect.any(String)],
      enabled: true,
      environment: { EDEN_URL: "https://e", EDEN_API_KEY: "k9", EDEN_USER_ID: "u1", EDEN_TENANT_ID: "t1" },
    });

    // VS Code user mcp.json: a plain `servers` table, stdio entries.
    const vsc = dir(base, "vsc/User/mcp.json");
    writeFileSync(vsc, '{ "servers": { "other": { "command": "x" }, }, }'); // trailing commas
    const vr = run(["--vscode-config", vsc, "--agents", "vscode", "--remote", "--eden-home", join(base, "eh")], env);
    expect(vr.exitCode, vr.stderr.toString()).toBe(0);
    const v = JSON.parse(readFileSync(vsc, "utf8"));
    expect(v.servers.other).toEqual({ command: "x" });
    expect(v.servers.eden.type).toBe("stdio");
    expect(v.servers.eden.command).toBe("python3");
    expect(v.servers.eden.env.EDEN_API_KEY).toBe("k9");

    // A corrupt container ({,}) is not a trailing comma: the file is warned and untouched.
    const corrupt = dir(base, "corrupt/settings.json");
    writeFileSync(corrupt, '{ "mcpServers": {,} }');
    const cr2 = run(["--cline-config", corrupt, "--agents", "cline", "--remote", "--eden-home", join(base, "eh")], env);
    expect(cr2.exitCode).toBe(1);
    expect(cr2.stderr.toString()).toContain("not a JSON object");
    expect(readFileSync(corrupt, "utf8")).toBe('{ "mcpServers": {,} }');

    // Goose: a comment deeper than the real entries must not set Eden's indent.
    const goose2 = dir(base, "g2/config.yaml");
    writeFileSync(goose2, "extensions:\n        # managed list\n  developer:\n    type: builtin\n");
    const g2 = run(["--goose-config", goose2, "--agents", "goose", "--remote", "--eden-home", join(base, "eh")], env);
    expect(g2.exitCode, g2.stderr.toString()).toBe(0);
    const g2t = readFileSync(goose2, "utf8");
    expect(g2t).toContain("  eden:\n    type: stdio");
    expect(g2t).toContain("  developer:\n    type: builtin");
    expect(g2t).toContain("        # managed list");

    // Goose: a commented-out extension inside the replaced eden block is user content — kept.
    const goose3 = dir(base, "g3/config.yaml");
    writeFileSync(
      goose3,
      "extensions:\n  eden:\n    type: stdio\n  # disabled-for-now:\n  # type: builtin\n    note: inside-eden-block\n  developer:\n    type: builtin\n",
    );
    const g3 = run(["--goose-config", goose3, "--agents", "goose", "--remote", "--eden-home", join(base, "eh")], env);
    expect(g3.exitCode, g3.stderr.toString()).toBe(0);
    const g3t = readFileSync(goose3, "utf8");
    expect(g3t).toContain("# disabled-for-now:");
    expect(g3t).toContain("# type: builtin");
    expect(g3t).not.toContain("inside-eden-block");

    // A comment inside the dropped eden block resurfaces at the child indent —
    // kept as user content, but out of the preceding extension's block scalar.
    const goose4 = dir(base, "g4/config.yaml");
    writeFileSync(
      goose4,
      "extensions:\n  developer:\n    prompt: |\n      hello\n      world\n  eden:\n    type: stdio\n      \n    # managed list\n",
    );
    const g4 = run(["--goose-config", goose4, "--agents", "goose", "--remote", "--eden-home", join(base, "eh")], env);
    expect(g4.exitCode, g4.stderr.toString()).toBe(0);
    const g4t = readFileSync(goose4, "utf8");
    expect(g4t).toContain("prompt: |\n      hello\n      world\n  # managed list");
    expect(g4t).not.toContain("      \n");
    expect(g3t).toContain("  developer:\n    type: builtin");
    expect(g3t.split("eden:").length - 1).toBe(1);

    // A merged config may hold the API key: group/other must never read it, even on a 0644 file.
    const cline = dir(base, "c/settings.json");
    writeFileSync(cline, "{}");
    const cr = run(["--cline-config", cline, "--agents", "cline", "--remote", "--eden-home", join(base, "eh")], env);
    expect(cr.exitCode, cr.stderr.toString()).toBe(0);
    expect(statSync(cline).mode & 0o077).toBe(0);
  });
});
