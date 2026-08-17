import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeConfig, ensureHome, edenHome, resolveApiKey, readConfig, wrapPlaneUrl, sitePlaneUrl } from "./home";

function claudeSettingsDir(scope: "user" | "project"): string {
  if (scope === "user") return join(homedir(), ".claude");
  return join(process.cwd(), ".claude");
}

export function hookCommand(
  cliPath: string,
  hookdPort = Number(process.env.EDEN_HOOKD_PORT || 8794),
  opts: { failOpen?: boolean } = {},
): string {
  const hookd = `http://127.0.0.1:${hookdPort}/hook`;
  const bunHook = `bun "${cliPath}" hook`;
  const ms = Number(process.env.EDEN_HOOKD_TIMEOUT_MS || 8000);
  const sec = Math.min(60, Math.max(2, Math.ceil((Number.isFinite(ms) ? ms : 8000) / 1000)));
  const core = `curl -sS --max-time ${sec} -H 'content-type: application/json' --data-binary @- ${hookd} || ${bunHook}`;
  return opts.failOpen === false ? core : `${core} || echo '{}'`;
}

export function installedHooks(hookCmd: string, preCmd = hookCmd.replace(/ \|\| echo '\{\}'$/, "")) {
  return {
    PreToolUse: [{ hooks: [{ type: "command" as const, command: preCmd }] }],
    PostToolUse: [{ hooks: [{ type: "command" as const, command: hookCmd }] }],
    Stop: [{ hooks: [{ type: "command" as const, command: hookCmd }] }],
    SessionStart: [{ hooks: [{ type: "command" as const, command: hookCmd }] }],
  };
}

export function wrapMcpServer(cliPath: string): { command: string; args: string[] } {
  return { command: "bun", args: [cliPath, "mcp"] };
}

export async function setup(args: string[]): Promise<void> {
  const sessionIdx = args.indexOf("--session");
  const token = sessionIdx >= 0 ? args[sessionIdx + 1] : process.env.EDEN_SETUP_TOKEN;
  const wrap = wrapPlaneUrl(process.env.EDEN_WRAP_URL || process.env.EDEN_BASE_URL || readConfig()?.base_url);
  const site = sitePlaneUrl(process.env.EDEN_SITE_URL || process.env.EDEN_BASE_URL);
  let apiKey: string | undefined;
  if (token) {
    const res = await fetch(`${site}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      const j = (await res.json()) as { api_key?: unknown };
      if (typeof j.api_key === "string" && j.api_key) apiKey = j.api_key;
    }
    if (!apiKey) throw new Error("eden setup --session could not exchange a token");
  }
  if (!apiKey) {
    try {
      apiKey = resolveApiKey(args);
    } catch {
      throw new Error("eden setup needs --session, --key, EDEN_API_KEY, eden login, or --dev");
    }
  }
  ensureHome();
  writeConfig({ api_key: apiKey, base_url: wrap });

  const cliPath = join(import.meta.dir, "cli.ts");
  const hookCmd = hookCommand(cliPath);
  const headersCmd = `bun "${cliPath}" mcp-headers`;

  const userClaude = claudeSettingsDir("user");
  mkdirSync(userClaude, { recursive: true });

  const settingsPath = join(userClaude, "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  settings.hooks = {
    ...(settings.hooks || {}),
    ...installedHooks(hookCmd),
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const mcpPath = join(process.cwd(), ".mcp.json");
  let mcp: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(mcpPath)) {
    try {
      mcp = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers?: Record<string, unknown> };
    } catch {
      mcp = {};
    }
  }
  mcp.mcpServers = {
    ...(mcp.mcpServers || {}),
    eden: wrapMcpServer(cliPath),
  };
  if (process.env.EDEN_SITE_MCP === "1") {
    mcp.mcpServers["eden-site"] = {
      type: "http",
      url: `${site}/mcp`,
      headersHelper: headersCmd,
    };
  }
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));

  console.log("Eden setup complete.");
  console.log(`  key stored in ${join(edenHome(), "config.json")}`);
  console.log(`  wrap  ${wrap}`);
  console.log(`  hooks → ${settingsPath}`);
  console.log(`  mcp   → ${mcpPath} (stdio bun … mcp)`);
  console.log(`  run \`eden hookd\` (or \`bun "${cliPath}" hookd\`) so Pre/Post/Stop stay warm.`);
}
