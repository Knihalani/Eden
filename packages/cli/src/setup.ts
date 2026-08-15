import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeConfig, ensureHome, edenHome } from "./home";

function claudeSettingsDir(scope: "user" | "project"): string {
  if (scope === "user") return join(homedir(), ".claude");
  return join(process.cwd(), ".claude");
}

export function hookCommand(cliPath: string, hookdPort = Number(process.env.EDEN_HOOKD_PORT || 8794)): string {
  const hookd = `http://127.0.0.1:${hookdPort}/hook`;
  const bunHook = `bun "${cliPath}" hook`;
  return `curl -sS --max-time 8 -H 'content-type: application/json' --data-binary @- ${hookd} || ${bunHook} || echo '{}'`;
}

export async function setup(args: string[]): Promise<void> {
  const sessionIdx = args.indexOf("--session");
  const token = sessionIdx >= 0 ? args[sessionIdx + 1] : process.env.EDEN_SETUP_TOKEN;
  const base = process.env.EDEN_BASE_URL || "http://127.0.0.1:8787";
  let apiKey = "eden_dev";
  if (token) {
    const res = await fetch(`${base}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      const j = await res.json();
      apiKey = j.api_key || apiKey;
    }
  }
  ensureHome();
  writeConfig({ api_key: apiKey, base_url: base });

  const cliPath = join(import.meta.dir, "cli.ts");
  const hookCmd = hookCommand(cliPath);
  const headersCmd = `bun "${cliPath}" mcp-headers`;

  const userClaude = claudeSettingsDir("user");
  mkdirSync(userClaude, { recursive: true });

  const settingsPath = join(userClaude, "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  settings.hooks = {
    ...(settings.hooks || {}),
    PreToolUse: [{ hooks: [{ type: "command", command: hookCmd }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: hookCmd }] }],
    PostToolUseFailure: [{ hooks: [{ type: "command", command: hookCmd }] }],
    Stop: [{ hooks: [{ type: "command", command: hookCmd }] }],
    SessionStart: [{ hooks: [{ type: "command", command: hookCmd }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCmd }] }],
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const mcpPath = join(process.cwd(), ".mcp.json");
  writeFileSync(
    mcpPath,
    JSON.stringify(
      {
        mcpServers: {
          eden: {
            type: "http",
            url: `${base}/mcp`,
            headersHelper: headersCmd,
          },
        },
      },
      null,
      2,
    ),
  );

  console.log("Eden setup complete.");
  console.log(`  key stored in ${join(edenHome(), "config.json")}`);
  console.log(`  hooks → ${settingsPath}`);
  console.log(`  mcp   → ${mcpPath}`);
  console.log(`  run \`eden hookd\` (or \`bun "${cliPath}" hookd\`) so Pre/Post/Stop stay warm.`);
}
