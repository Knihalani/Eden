import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeConfig, ensureHome, edenHome, resolveApiKey, readConfig, wrapPlaneUrl, sitePlaneUrl, writeFileAtomic } from "./home";

function claudeSettingsDir(scope: "user" | "project"): string {
  if (scope === "user") return join(homedir(), ".claude");
  return join(process.cwd(), ".claude");
}

/** POSIX single-quoting: the only form a shell does no substitution inside. */
function shq(v: string): string {
  return `'${v.replaceAll("'", `'\\''`)}'`;
}

/**
 * The PreToolUse probe: a single curl with a one-second ceiling that fails
 * open to `{}` and never spawns bun.
 *
 * PreToolUse runs on *every* tool call, and it used to share the PostToolUse
 * chain — `--max-time 8` curl, then a cold `bun <cli> hook` spawn. When hookd
 * was down, a tool call blocked for up to eight-plus seconds before the CLI
 * even started. Ordinary tool calls must never wait on Eden, so the Pre path
 * gives up after 1s and answers `{}`, which lets the call proceed; the deny
 * steering toward compiled tools is best-effort by design.
 */
export function preHookCommand(hookdPort = Number(process.env.EDEN_HOOKD_PORT || 8794)): string {
  const hookd = `http://127.0.0.1:${hookdPort}/hook`;
  return `curl -sS --max-time 1 -H 'content-type: application/json' --data-binary @- ${hookd} || echo '{}'`;
}

export function hookCommand(
  cliPath: string,
  hookdPort = Number(process.env.EDEN_HOOKD_PORT || 8794),
  opts: { failOpen?: boolean } = {},
): string {
  const hookd = `http://127.0.0.1:${hookdPort}/hook`;
  // Single-quoted, not double: this string is persisted into the user's
  // settings.json and run by a shell on every tool call, and double quotes do
  // not stop `$(...)` or backticks. An install path is not usually hostile,
  // but it is not always chosen by the person being protected either.
  const bunHook = `bun ${shq(cliPath)} hook`;
  const ms = Number(process.env.EDEN_HOOKD_TIMEOUT_MS || 8000);
  const sec = Math.min(60, Math.max(2, Math.ceil((Number.isFinite(ms) ? ms : 8000) / 1000)));
  const core = `curl -sS --max-time ${sec} -H 'content-type: application/json' --data-binary @- ${hookd} || ${bunHook}`;
  return opts.failOpen === false ? core : `${core} || echo '{}'`;
}

export function installedHooks(hookCmd: string, preCmd: string = preHookCommand()) {
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

// ── Multi-agent recording (Gemini CLI / OpenCode / Codex) ───────────────────
//
// Claude Code is the reference integration; the same fail-open probe now
// installs wherever an interception point exists. Everything here follows the
// house rules: merge idempotently, never clobber user config, back up what we
// cannot parse, and answer "allow" when Eden itself is down.

/** Gemini CLI (v0.26+ hooks): BeforeToolUse/AfterToolUse command entries. */
export function geminiHookConfig(existing: unknown, preCmd: string, hookCmd: string): Record<string, unknown> {
  const prev = (existing && typeof existing === "object" ? existing : {}) as Record<string, unknown>;
  const hooks = (prev.hooks as Record<string, unknown[]> | undefined) ?? {};
  return {
    ...prev,
    hooks: {
      ...hooks,
      BeforeToolUse: [{ command: preCmd }],
      AfterToolUse: [{ command: hookCmd }],
    },
  };
}

/**
 * Codex CLI (experimental hooks engine): SessionStart/SessionStop only today —
 * session-boundary recording is honest coverage; per-call steering arrives
 * when OpenAI ships PreToolUse. TOML is appended between markers so re-running
 * setup replaces our section and nothing else.
 */
export function codexTomlSection(hookCmd: string): string {
  return [
    "",
    "# --- eden-recorder (managed; re-run `eden setup` to refresh) ---",
    "[features]",
    "codex_hooks = true",
    "",
    "[hooks.eden]",
    `session_start = ["sh", "-c", ${JSON.stringify(`curl -sS --max-time 1 -X POST -H 'content-type: application/json' --data-binary '{"event":"session_start"}' http://127.0.0.1:${Number(process.env.EDEN_HOOKD_PORT || 8794)}/hook || true`)}]`,
    `session_stop = ["sh", "-c", ${JSON.stringify(`curl -sS --max-time 1 -X POST -H 'content-type: application/json' --data-binary '{"event":"session_stop"}' http://127.0.0.1:${Number(process.env.EDEN_HOOKD_PORT || 8794)}/hook || true`)}]`,
    `post_tool = ["sh", "-c", ${JSON.stringify(hookCmd)}]`,
    "# --- end eden-recorder ---",
    "",
  ].join("\n");
}

export function applyCodexToml(existing: string, hookCmd: string): string {
  const start = existing.indexOf("# --- eden-recorder");
  if (start >= 0) {
    const end = existing.indexOf("# --- end eden-recorder ---", start);
    if (end >= 0) {
      return existing.slice(0, start) + codexTomlSection(hookCmd).trimStart() + existing.slice(existing.indexOf("\n", end) + 1);
    }
  }
  return existing.replace(/\n*$/, "\n") + codexTomlSection(hookCmd);
}

/** OpenCode: a plugin module forwarding lifecycle events to hookd, fail-open. */
export function opencodePluginSource(): string {
  const port = Number(process.env.EDEN_HOOKD_PORT || 8794);
  return [
    "// Managed by `eden setup` — records tool events to the local hookd.",
    "// Fail-open by contract: a dead recorder never blocks a tool call.",
    `const HOOKD = "http://127.0.0.1:${port}/hook"`,
    "",
    "async function send(event, payload) {",
    "  try {",
    "    await fetch(HOOKD, {",
    "      method: \"POST\",",
    "      headers: { \"content-type\": \"application/json\" },",
    "      body: JSON.stringify({ event, ...payload }),",
    "      signal: AbortSignal.timeout(1000),",
    "    })",
    "  } catch {",
    "    // swallow: recording is best-effort",
    "  }",
    "}",
    "",
    "export const EdenRecorderPlugin = async ({ project }) => ({",
    "  \"tool.execute.before\": async (input, output) => {",
    "    await send(\"pre_tool\", { tool: input?.tool, args: output?.args })",
    "  },",
    "  \"tool.execute.after\": async (input, output) => {",
    "    await send(\"post_tool\", { tool: input?.tool, ok: !output?.error })",
    "  },",
    "})",
    "",
  ].join("\n");
}

type HookEntry = { hooks?: Array<{ type?: string; command?: string }> };
type HookMap = Record<string, HookEntry[]>;

/**
 * Is this one of ours, from a previous `eden setup`?
 *
 * Both spellings of the command — the curl to hookd and the `bun … hook`
 * fallback — appear in the same string, so either is enough to recognise it.
 */
function isEdenHook(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((h) => {
    const c = String(h?.command ?? "");
    return /127\.0\.0\.1:\d+\/hook\b/.test(c) || /\bcli\.ts'?"?\s+hook\b/.test(c);
  });
}

/**
 * Add Eden's hooks alongside whatever is already installed.
 *
 * This was a shallow spread of one object over another, so Eden's
 * PreToolUse/PostToolUse/Stop/SessionStart arrays *replaced* the user's
 * entries for those events outright. Anyone who had their own PreToolUse hook
 * — a command allowlist, an audit log, a secret scanner — silently lost it the
 * first time they ran `eden setup`, and Eden is not entitled to disarm
 * somebody's guard rail in order to install itself.
 *
 * Re-running setup replaces our own previous entry rather than appending a
 * second copy, so it stays idempotent.
 */
export function mergeHooks(existing: unknown, ours: HookMap): HookMap {
  const out: HookMap = {};
  const prev = (existing && typeof existing === "object" ? existing : {}) as HookMap;
  for (const [event, entries] of Object.entries(prev)) {
    if (Array.isArray(entries)) out[event] = entries.filter((e) => !isEdenHook(e));
  }
  for (const [event, entries] of Object.entries(ours)) {
    out[event] = [...(out[event] ?? []), ...entries];
  }
  return out;
}

/**
 * A settings file we cannot parse is not a reason to abort setup, and it is
 * certainly not a reason to overwrite it unseen: it is kept alongside so the
 * user can get their configuration back.
 */
function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through to the backup path */
  }
  const backup = `${path}.eden-backup-${Date.now()}`;
  writeFileAtomic(backup, raw);
  console.warn(`eden setup: ${path} was not valid JSON. Kept a copy at ${backup} and started a fresh one.`);
  return {};
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
  const preCmd = preHookCommand();
  const headersCmd = `bun "${cliPath}" mcp-headers`;

  const userClaude = claudeSettingsDir("user");
  mkdirSync(userClaude, { recursive: true });

  const settingsPath = join(userClaude, "settings.json");
  const settings = readSettings(settingsPath);
  settings.hooks = mergeHooks(settings.hooks, installedHooks(hookCmd, preCmd));
  writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2));

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
  writeFileAtomic(mcpPath, JSON.stringify(mcp, null, 2));

  // Other agents: install where they are actually present (their config dirs
  // existing is the detection signal), or force with --all-agents. A missing
  // agent's config is never created out of thin air.
  const allAgents = args.includes("--all-agents");
  const agents: string[] = [];
  const geminiDir = join(homedir(), ".gemini");
  if (allAgents || existsSync(geminiDir)) {
    try {
      mkdirSync(geminiDir, { recursive: true });
      const gPath = join(geminiDir, "settings.json");
      const g = readSettings(gPath);
      writeFileAtomic(gPath, JSON.stringify(geminiHookConfig(g, preCmd, hookCmd), null, 2));
      agents.push(`gemini → ${gPath}`);
    } catch {
      /* a failed side install never fails setup */
    }
  }
  const codexHome = join(homedir(), ".codex");
  if (allAgents || existsSync(codexHome)) {
    try {
      mkdirSync(codexHome, { recursive: true });
      const cPath = join(codexHome, "config.toml");
      const existingToml = existsSync(cPath) ? readFileSync(cPath, "utf8") : "";
      writeFileAtomic(cPath, applyCodexToml(existingToml, hookCmd));
      agents.push(`codex → ${cPath} (session-boundary recording)`);
    } catch {
      /* best-effort */
    }
  }
  const ocDir = join(homedir(), ".config", "opencode", "plugin");
  if (allAgents || existsSync(join(homedir(), ".config", "opencode"))) {
    try {
      mkdirSync(ocDir, { recursive: true });
      const oPath = join(ocDir, "eden-recorder.js");
      writeFileAtomic(oPath, opencodePluginSource());
      agents.push(`opencode → ${oPath}`);
    } catch {
      /* best-effort */
    }
  }

  console.log("Eden setup complete.");
  console.log(`  key stored in ${join(edenHome(), "config.json")}`);
  console.log(`  wrap  ${wrap}`);
  console.log(`  hooks → ${settingsPath}`);
  console.log(`  mcp   → ${mcpPath} (stdio bun … mcp)`);
  for (const line of agents) console.log(`  ${line}`);
  if (!agents.length) {
    console.log("  other agents: none detected (re-run with --all-agents to install anyway)");
  }
  console.log(`  run \`eden hookd\` (or \`bun "${cliPath}" hookd\`) so Pre/Post/Stop stay warm.`);
}
