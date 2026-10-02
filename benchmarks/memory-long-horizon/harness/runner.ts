/**
 * Runs a plugin's hooks the way Claude Code does: one fresh process per handler per event, matched by the
 * plugin's `hooks/hooks.json`, with the payload on stdin, Claude Code's hook environment variables, the
 * documented timeouts, and stdout read by Claude Code's rules (exit codes, JSON vs plain text,
 * `additionalContext`, blocking). Matching handlers of one event run in parallel, as documented.
 *
 * Handler features the simulator does not model yet are rejected when the plugin loads, rather than
 * silently run differently: `if` filters (P2.3 needs them), `async` hooks, and non-command handler types.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HookEvent, HookPayload } from "./payloads";

export interface HookHandler {
  type: "command";
  command: string;
  args?: string[];
  /** Seconds. */
  timeout?: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

export interface Plugin {
  name: string;
  root: string;
  hooks: Partial<Record<HookEvent, HookGroup[]>>;
}

const SUPPORTED_HANDLER_FIELDS = new Set(["type", "command", "args", "timeout", "statusMessage"]);

export function loadPlugin(root: string): Plugin {
  const manifest = join(root, ".claude-plugin", "plugin.json");
  const name = existsSync(manifest)
    ? String((JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name ?? basename(root))
    : basename(root);
  const config = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as {
    hooks?: Record<string, HookGroup[]>;
  };
  const hooks = config.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        const unsupported = Object.keys(handler).filter((key) => !SUPPORTED_HANDLER_FIELDS.has(key));
        if (handler.type !== "command" || unsupported.length) {
          const what = handler.type !== "command" ? `type "${handler.type}"` : unsupported.join(", ");
          throw new Error(`${name}: ${event} handler uses ${what}, which the simulator does not model`);
        }
      }
    }
  }
  return { name, root, hooks: hooks as Plugin["hooks"] };
}

/** The payload field each event's matcher filters on; undefined for events without matcher support. */
export function matchedField(payload: HookPayload): string | undefined {
  switch (payload.hook_event_name) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
      return String(payload.tool_name);
    case "SessionStart":
      return String(payload.source);
    case "SessionEnd":
      return String(payload.reason);
    case "SubagentStart":
    case "SubagentStop":
      return String(payload.agent_type);
    case "PreCompact":
    case "PostCompact":
      return String(payload.trigger);
    case "InstructionsLoaded":
      return String(payload.load_reason);
    default:
      return undefined;
  }
}

/**
 * The documented matcher rules: `*`, empty or absent match all; letters, digits, `_`, `-`, spaces, `,` and
 * `|` mean exact names; anything else is an unanchored JavaScript regular expression.
 */
export function matcherAccepts(matcher: string | undefined, value: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*" || value === undefined) return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((name) => name.trim())
      .includes(value);
  }
  return new RegExp(matcher).test(value);
}

/** What Claude Code makes of one handler's run. */
export interface HookOutcome {
  /** How stdout is read: JSON when it starts with `{` and ends with `}`, plain text otherwise. */
  output: "none" | "json" | "text" | "invalid-json";
  json?: Record<string, unknown>;
  /** The context Claude Code would insert, if any. */
  additionalContext?: string;
  /** Exit 2 on an event that can block, `decision: "block"`, or `continue: false`. */
  blocked: boolean;
  permissionDecision?: "allow" | "deny" | "ask" | "defer";
  /** The `<hook name> hook error` notice Claude Code would show, if any. */
  error?: string;
}

export interface Invocation {
  command: string;
  pid: number;
  /** `performance.now()` at spawn and at exit, for overlap checks. */
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outcome: HookOutcome;
}

/** Events whose `additionalContext` Claude Code inserts (hooks reference, "Add context for Claude"). */
const CONTEXT_EVENTS = new Set<HookEvent>([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "SubagentStart",
  "Stop",
  "SubagentStop",
]);

/** Events where plain-text stdout on exit 0 becomes context. */
const PLAIN_TEXT_CONTEXT = new Set<HookEvent>(["SessionStart", "UserPromptSubmit"]);

/** Events that exit code 2 blocks (hooks reference, "Exit code 2 behavior per event"). */
const EXIT_2_BLOCKS = new Set<HookEvent>([
  "PreToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PostToolBatch",
  "PreCompact",
]);

const DECISION_BLOCKS = new Set<HookEvent>(["UserPromptSubmit", "PostToolBatch", "Stop", "SubagentStop", "PreCompact"]);

export function interpretOutput(
  event: HookEvent,
  exitCode: number | null,
  stdout: string,
  timedOut: boolean,
): HookOutcome {
  if (timedOut) return { output: "none", blocked: false, error: "timed out; output discarded" };
  const text = stdout.trim();
  const output: HookOutcome["output"] = !text
    ? "none"
    : text.startsWith("{") && text.endsWith("}")
      ? parsesAsObject(text)
        ? "json"
        : "invalid-json"
      : "text";
  const outcome: HookOutcome = { output, blocked: exitCode === 2 && EXIT_2_BLOCKS.has(event) };
  if (output === "invalid-json") outcome.error = "hook output is not valid JSON";
  if (output === "json") Object.assign(outcome, readJson(event, JSON.parse(text) as Record<string, unknown>));
  if (output === "text" && exitCode === 0 && PLAIN_TEXT_CONTEXT.has(event)) outcome.additionalContext = text;
  if (exitCode === 2 && event === "PreToolUse") outcome.permissionDecision = "deny";
  if (exitCode !== 0 && exitCode !== 2 && output !== "json") {
    outcome.error ??= `Failed with non-blocking status code ${exitCode}`;
  }
  return outcome;
}

function parsesAsObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function readJson(event: HookEvent, json: Record<string, unknown>): Partial<HookOutcome> {
  const read: Partial<HookOutcome> = { json };
  if (json.continue === false || (json.decision === "block" && DECISION_BLOCKS.has(event))) read.blocked = true;
  const specific = json.hookSpecificOutput;
  if (specific && typeof specific === "object") {
    const fields = specific as Record<string, unknown>;
    if (fields.hookEventName !== event) {
      read.error = `hookSpecificOutput.hookEventName is ${JSON.stringify(fields.hookEventName)}, not ${event}`;
      return read;
    }
    if (typeof fields.additionalContext === "string" && CONTEXT_EVENTS.has(event)) {
      read.additionalContext = fields.additionalContext;
    }
    const decision = fields.permissionDecision;
    if (event === "PreToolUse" && PERMISSION_DECISIONS.includes(decision)) {
      read.permissionDecision = decision as HookOutcome["permissionDecision"];
    }
  }
  return read;
}

const PERMISSION_DECISIONS: readonly unknown[] = ["allow", "deny", "ask", "defer"];

/** Seconds before Claude Code cancels a command hook (hooks reference, "Common fields"). */
export function timeoutSeconds(event: HookEvent, handler: HookHandler): number {
  // SessionEnd hooks share a 1.5 s budget, and a plugin hook's own timeout does not raise it.
  if (event === "SessionEnd") return Math.min(handler.timeout ?? 1.5, 1.5);
  return handler.timeout ?? (event === "UserPromptSubmit" ? 30 : 600);
}

export interface RunnerOptions {
  plugin: Plugin;
  /** The complete environment of every hook process (see `hookEnv`). */
  env: Record<string, string>;
  /** Where hooks run when the payload's `cwd` no longer exists. */
  projectDir: string;
}

export class HookRunner {
  constructor(private readonly options: RunnerOptions) {}

  /** Runs every handler that matches the payload, in parallel, each in its own process. */
  async dispatch(payload: HookPayload): Promise<Invocation[]> {
    const event = payload.hook_event_name;
    const value = matchedField(payload);
    const handlers = (this.options.plugin.hooks[event] ?? [])
      .filter((group) => matcherAccepts(group.matcher, value))
      .flatMap((group) => group.hooks);
    return Promise.all(handlers.map((handler) => this.run(event, handler, payload)));
  }

  private async run(event: HookEvent, handler: HookHandler, payload: HookPayload): Promise<Invocation> {
    const root = this.options.plugin.root;
    const cmd = handler.args
      ? [handler.command, ...handler.args].map((part) => part.replaceAll("${CLAUDE_PLUGIN_ROOT}", root))
      : ["/bin/sh", "-c", handler.command];
    const cwd = typeof payload.cwd === "string" && existsSync(payload.cwd) ? payload.cwd : this.options.projectDir;
    const startedAt = performance.now();
    // Its own process group, so a timeout kills the hook's children too and none keeps a pipe open. The
    // payload goes in as a buffer that Bun writes: a hook that exits without reading it cannot stall us.
    const child = Bun.spawn({
      cmd,
      cwd,
      env: this.options.env,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        killGroup(child.pid);
      },
      timeoutSeconds(event, handler) * 1000,
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    const endedAt = performance.now();
    return {
      command: handler.command,
      pid: child.pid,
      startedAt,
      endedAt,
      exitCode: timedOut ? null : exitCode,
      timedOut,
      stdout,
      stderr,
      outcome: interpretOutput(event, timedOut ? null : exitCode, stdout, timedOut),
    };
  }
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

/**
 * A hook process's environment: a minimal base (PATH, TMPDIR, LANG) plus Claude Code's hook variables, with
 * HOME, EDEN_HOME and EDEN_MEMORY_DIR inside the run directory, so no hook can reach a real store. Nothing
 * else is inherited, so runs do not depend on the caller's shell.
 */
export function hookEnv(paths: {
  home: string;
  projectDir: string;
  plugin: Plugin;
  extra?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    HOME: paths.home,
    EDEN_HOME: join(paths.home, ".eden"),
    EDEN_MEMORY_DIR: join(paths.home, ".eden", "memory"),
    CLAUDE_PROJECT_DIR: paths.projectDir,
    CLAUDE_PLUGIN_ROOT: paths.plugin.root,
    CLAUDE_PLUGIN_DATA: join(paths.home, ".claude", "plugins", "data", paths.plugin.name),
  };
  return { ...env, ...paths.extra };
}
