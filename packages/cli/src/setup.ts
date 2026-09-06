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
  // Bake home into the bun fallback (and the spawned hookd it warms). Curl
  // itself ignores EDEN_HOME; without this, wrap/hookd on a custom home and
  // Claude's bun path on ~/.eden split the remainder store.
  const core = `${edenHomeExport()}; curl -sS --max-time ${sec} -H 'content-type: application/json' --data-binary @- ${hookd} || ${bunHook}`;
  return opts.failOpen === false ? core : `${core} || echo '{}'`;
}

/** Install-time home, POSIX-quoted. Same token Claude, Gemini, Codex, and OpenCode bake. */
function edenHomeExport(): string {
  return `export EDEN_HOME=${shq(edenHome())}`;
}

export function installedHooks(hookCmd: string, preCmd: string = preHookCommand()) {
  return {
    PreToolUse: [{ hooks: [{ type: "command" as const, command: preCmd }] }],
    PostToolUse: [{ hooks: [{ type: "command" as const, command: hookCmd }] }],
    // Host has no matcher for PostToolBatch. One Eden command, same warm chain
    // as PostToolUse. Remainder arms from the full parallel set here (R2).
    PostToolBatch: [{ hooks: [{ type: "command" as const, command: hookCmd }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command" as const, command: hookCmd }] }],
    PreCompact: [{ hooks: [{ type: "command" as const, command: hookCmd }] }],
    Stop: [{ hooks: [{ type: "command" as const, command: hookCmd }] }],
    SessionStart: [{ hooks: [{ type: "command" as const, command: hookCmd }] }],
  };
}

export function wrapMcpServer(cliPath: string): { command: string; args: string[] } {
  return { command: "bun", args: [cliPath, "mcp"] };
}

/**
 * Path hooks and MCP should invoke. After `npm i -g` that is dist/eden.js
 * (process.argv[1]), not a sibling cli.ts that does not ship.
 */
export function installedCliPath(): string {
  const sibling = join(import.meta.dir, "cli.ts");
  const dist = join(import.meta.dir, "eden.js");
  const argv1 = process.argv[1];
  if (
    argv1 &&
    existsSync(argv1) &&
    (argv1.endsWith("cli.ts") || argv1.endsWith("eden.js") || /(?:^|\/)eden$/.test(argv1))
  ) {
    return argv1;
  }
  if (existsSync(sibling)) return sibling;
  if (existsSync(dist)) return dist;
  if (argv1 && existsSync(argv1)) return argv1;
  return sibling;
}

// ── Multi-agent recording (Gemini CLI / OpenCode / Codex) ───────────────────
//
// Claude Code is the reference integration; the same fail-open probe now
// installs wherever an interception point exists. Everything here follows the
// house rules: merge idempotently, never clobber user config, back up what we
// cannot parse, and answer "allow" when Eden itself is down.

/**
 * Gemini CLI hooks: BeforeTool/AfterTool (native) plus BeforeToolUse/AfterToolUse
 * (the names this installer has always written). One Eden command per key.
 * Re-running setup replaces our entry and keeps the user's.
 */
function isEdenGeminiEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { command?: string; hooks?: Array<{ command?: string }> };
  const cmds = [e.command, ...(e.hooks ?? []).map((h) => h.command)];
  return cmds.some((c) => {
    const s = String(c ?? "");
    return /127\.0\.0\.1:\d+\/hook\b/.test(s) || /\bcli\.ts'?"?\s+hook\b/.test(s);
  });
}

function mergeGeminiEvent(existing: unknown, ours: { command: string }): Array<{ command: string } | Record<string, unknown>> {
  const prev = Array.isArray(existing)
    ? existing.filter((e) => !isEdenGeminiEntry(e) && (e as { command?: string }).command !== ours.command)
    : [];
  return [...prev, ours];
}

export function geminiHookConfig(existing: unknown, preCmd: string, hookCmd: string): Record<string, unknown> {
  const prev = (existing && typeof existing === "object" ? existing : {}) as Record<string, unknown>;
  const hooks = (prev.hooks as Record<string, unknown> | undefined) ?? {};
  return {
    ...prev,
    hooks: {
      ...hooks,
      BeforeToolUse: mergeGeminiEvent(hooks.BeforeToolUse, { command: preCmd }),
      AfterToolUse: mergeGeminiEvent(hooks.AfterToolUse, { command: hookCmd }),
      BeforeTool: mergeGeminiEvent(hooks.BeforeTool, { command: preCmd }),
      AfterTool: mergeGeminiEvent(hooks.AfterTool, { command: hookCmd }),
    },
  };
}

/**
 * Codex CLI hooks: one managed TOML section. `post_tool` stdin is the tool
 * event (piped to hookd); stdout is Claude-like PostToolUse JSON
 * (`postToolUseReplacement`) so the host can apply the rewrite. `pre_tool`
 * is the fast fail-open remainder probe. Re-running setup replaces this
 * section and nothing else.
 */
export function codexTomlSection(hookCmd: string, preCmd: string = preHookCommand()): string {
  const port = Number(process.env.EDEN_HOOKD_PORT || 8794);
  const home = edenHomeExport();
  const start = `${home}; curl -sS --max-time 1 -X POST -H 'content-type: application/json' --data-binary '{"event":"session_start"}' http://127.0.0.1:${port}/hook || true`;
  const stop = `${home}; curl -sS --max-time 1 -X POST -H 'content-type: application/json' --data-binary '{"event":"session_stop"}' http://127.0.0.1:${port}/hook || true`;
  return [
    "",
    "# --- eden-recorder (managed; re-run `eden setup` to refresh) ---",
    "[features]",
    "codex_hooks = true",
    "",
    "[hooks.eden]",
    `session_start = ["sh", "-c", ${JSON.stringify(start)}]`,
    `session_stop = ["sh", "-c", ${JSON.stringify(stop)}]`,
    `pre_tool = ["sh", "-c", ${JSON.stringify(preCmd)}]`,
    `post_tool = ["sh", "-c", ${JSON.stringify(hookCmd)}]`,
    "# --- end eden-recorder ---",
    "",
  ].join("\n");
}

export function applyCodexToml(existing: string, hookCmd: string, preCmd: string = preHookCommand()): string {
  const start = existing.indexOf("# --- eden-recorder");
  if (start >= 0) {
    const end = existing.indexOf("# --- end eden-recorder ---", start);
    if (end >= 0) {
      return existing.slice(0, start) + codexTomlSection(hookCmd, preCmd).trimStart() + existing.slice(existing.indexOf("\n", end) + 1);
    }
  }
  return existing.replace(/\n*$/, "\n") + codexTomlSection(hookCmd, preCmd);
}

/** OpenCode: one plugin module — the rewriter. Recording still goes to hookd. */
export function opencodePluginSource(cliPath = join(import.meta.dir, "cli.ts")): string {
  const port = Number(process.env.EDEN_HOOKD_PORT || 8794);
  return [
    "// Managed by `eden setup` — one rewriter. Re-running setup overwrites this file.",
    "// Fail-open by contract: a dead recorder never blocks a tool call.",
    // Same bake as Claude's `export EDEN_HOME=...; curl || bun hook` so a custom
    // home's bun fallback and the hookd it warms share remainder.json.
    `const EDEN_HOME = ${JSON.stringify(edenHome())}`,
    `const CLI = ${JSON.stringify(cliPath)}`,
    `const HOOKD = ${JSON.stringify(`http://127.0.0.1:${port}/hook`)}`,
    "const ALIAS = { bash: \"Bash\", shell: \"Bash\", read: \"Read\", write: \"Write\", grep: \"Grep\", glob: \"Glob\", webfetch: \"WebFetch\" }",
    "const pending = new Map()",
    "",
    "function mapTool(name) {",
    "  if (!name) return name",
    "  return ALIAS[String(name).toLowerCase()] || name",
    "}",
    "",
    "function mcpShaped(v) {",
    "  return !!(v && typeof v === \"object\" && Array.isArray(v.content) && v.content.length && typeof v.content[0]?.type === \"string\")",
    "}",
    "",
    "async function bunHook(payload) {",
    "  try {",
    "    const { spawnSync } = await import(\"node:child_process\")",
    "    const r = spawnSync(\"bun\", [CLI, \"hook\"], {",
    "      input: JSON.stringify(payload),",
    "      encoding: \"utf8\",",
    "      timeout: 8000,",
    "      env: { ...process.env, EDEN_HOME },",
    "    })",
    "    if (!r.stdout) return null",
    "    try { return JSON.parse(r.stdout) } catch { return null }",
    "  } catch {",
    "    return null",
    "  }",
    "}",
    "",
    "async function send(payload, bunFallback) {",
    "  try {",
    "    const res = await fetch(HOOKD, {",
    "      method: \"POST\",",
    "      headers: { \"content-type\": \"application/json\" },",
    "      body: JSON.stringify(payload),",
    "      signal: AbortSignal.timeout(bunFallback ? 8000 : 1000),",
    "    })",
    "    return await res.json()",
    "  } catch {",
    "    if (bunFallback) return await bunHook(payload)",
    "    return null",
    "  }",
    "}",
    "",
    "function applyAfter(output, hook) {",
    "  if (!hook || !output) return",
    "  const extra = hook.hookSpecificOutput?.additionalContext",
    "  const original = output.output",
    "  if (mcpShaped(original) || mcpShaped(output)) {",
    "    if (typeof extra === \"string\" && extra && Object.prototype.hasOwnProperty.call(output, \"inject\")) {",
    "      output.inject = extra",
    "    }",
    "    return",
    "  }",
    "  const u = hook.hookSpecificOutput?.updatedToolOutput",
    "  let text = typeof u === \"string\" ? u : \"\"",
    "  if (!text && u && typeof u === \"object\") {",
    "    text = u.stdout || u.file?.content || u.result || (typeof u.content === \"string\" ? u.content : \"\") || \"\"",
    "  }",
    "  if (!text && typeof extra === \"string\") text = extra",
    "  if (typeof output.output === \"string\" && text) {",
    "    output.output = text.includes(\"[eden:\") ? text : output.output + \"\\n\" + (extra || text)",
    "  } else if (typeof output.output === \"string\" && typeof extra === \"string\" && extra && !output.output.includes(\"[eden:\")) {",
    "    output.output = output.output + \"\\n\" + extra",
    "  }",
    "}",
    "",
    "export const EdenRecorderPlugin = async ({ project }) => ({",
    "  \"tool.execute.before\": async (input, output) => {",
    "    try { pending.set(input?.callID, output?.args) } catch { /* fail-open */ }",
    "    let hook = null",
    "    try {",
    "      hook = await send({",
    "        hook_event_name: \"PreToolUse\",",
    "        session_id: input?.sessionID,",
    "        tool_name: mapTool(input?.tool),",
    "        tool_input: output?.args ?? {},",
    "        cwd: project?.directory,",
    "      })",
    "    } catch {",
    "      return",
    "    }",
    "    if (hook?.hookSpecificOutput?.permissionDecision === \"deny\") {",
    "      throw new Error(hook.hookSpecificOutput.permissionDecisionReason || \"Already served by Eden.\")",
    "    }",
    "  },",
    "  \"tool.execute.after\": async (input, output) => {",
    "    try {",
    "      const args = pending.get(input?.callID) || output?.args || {}",
    "      try { pending.delete(input?.callID) } catch { /* ignore */ }",
    "      const hook = await send({",
    "        hook_event_name: \"PostToolUse\",",
    "        session_id: input?.sessionID,",
    "        tool_name: mapTool(input?.tool),",
    "        tool_input: args,",
    "        tool_response: output?.output,",
    "        cwd: project?.directory,",
    "      }, true)",
    "      applyAfter(output, hook)",
    "    } catch {",
    "      // swallow: a broken plugin never blocks the tool",
    "    }",
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

/** Replace Eden entries, keep the user's; re-run stays idempotent. */
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

  const cliPath = installedCliPath();
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
      writeFileAtomic(cPath, applyCodexToml(existingToml, hookCmd, preCmd));
      agents.push(`codex → ${cPath}`);
    } catch {
      /* best-effort */
    }
  }
  const ocDir = join(homedir(), ".config", "opencode", "plugin");
  if (allAgents || existsSync(join(homedir(), ".config", "opencode"))) {
    try {
      mkdirSync(ocDir, { recursive: true });
      const oPath = join(ocDir, "eden-recorder.js");
      writeFileAtomic(oPath, opencodePluginSource(cliPath));
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
  console.log(`  \`eden wrap\` (or \`eden hookd\`) keeps PreToolUse remainder warm; Stop with \`eden hookd --stop\`.`);
}
