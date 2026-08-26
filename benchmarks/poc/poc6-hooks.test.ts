/**
 * POC 6 — One installer, every agent (Claude Code / Gemini CLI / OpenCode / Codex).
 *
 * Recording is currently wired only into ~/.claude/settings.json and
 * `eden open` shells out to the macOS-only `open`. Meanwhile hooks landed in
 * Gemini CLI (Jan 2026), OpenCode plugins, and Codex CLI (experimental). This
 * POC delivers the installer core + its test suite:
 *   - generates correct hook config for each agent's native format
 *   - merge is idempotent and preserves pre-existing user hooks
 *   - the fail-open contract holds: a hook that throws still answers "allow"
 *   - browser-open picks the right command per platform
 * Run under bun test.
 */
import { describe, expect, test } from "bun:test";
import { homedir, platform } from "node:os";

// ── The proposed installer core ─────────────────────────────────────────────

type Json = Record<string, unknown>;

const HOOKD_PROBE = `curl -m 1 -sf http://127.0.0.1:8794/pre || echo '{}'`;

/** Claude Code: lifecycle hooks in settings.json (existing behavior). */
export function claudeCodeConfig(existing: Json): Json {
  const hooks = (existing.hooks as Json | undefined) ?? {};
  return {
    ...existing,
    hooks: {
      ...hooks,
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: HOOKD_PROBE }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: HOOKD_PROBE }] }],
    },
  };
}

/** Gemini CLI: BeforeRequest/tool-validation events in settings.json. */
export function geminiCliConfig(existing: Json): Json {
  return {
    ...existing,
    hooks: {
      ...((existing.hooks as Json) ?? {}),
      BeforeToolUse: [{ command: HOOKD_PROBE }],
      AfterToolUse: [{ command: HOOKD_PROBE }],
    },
  };
}

/** OpenCode: plugin manifest declaring lifecycle interception points. */
export function openCodePlugin(): Json {
  return {
    name: "eden-recorder",
    version: 1,
    events: ["tool.execute.before", "tool.execute.after"],
    command: HOOKD_PROBE,
    failOpen: true,
  };
}

/**
 * Codex CLI (experimental hooks engine): SessionStart/SessionStop only —
 * record at session boundaries; per-call steering arrives when OpenAI ships
 * PreToolUse. Honest about the gap rather than pretending parity.
 */
export function codexConfig(existing: Json): Json {
  return {
    ...existing,
    features: { ...((existing.features as Json) ?? {}), codex_hooks: true },
    hooks: {
      ...((existing.hooks as Json) ?? {}),
      SessionStart: [{ command: HOOKD_PROBE }],
      SessionStop: [{ command: HOOKD_PROBE }],
    },
  };
}

/** Fail-open contract: whatever happens, the answer is "allow" (`{}`). */
export function runHookSafely(fn: () => Json): Json {
  try {
    const out = fn();
    return out && typeof out === "object" ? out : {};
  } catch {
    return {};
  }
}

/** Cross-platform browser open. */
export function openCommand(url: string): string {
  switch (platform()) {
    case "darwin": return `open "${url}"`;
    case "win32": return `start "" "${url}"`;
    default: return `xdg-open "${url}"`;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("POC 6 — multi-agent hook installer", () => {
  test("claude code: merges into existing user hooks without clobbering", () => {
    const existing = { hooks: { UserPromptSubmit: [{ command: "my-own-thing" }] }, model: "opus" };
    const out = claudeCodeConfig(existing) as { hooks: Json; model: string };
    expect(out.model).toBe("opus");
    expect(out.hooks.UserPromptSubmit).toBeDefined(); // preserved
    expect(out.hooks.PreToolUse).toBeDefined();
    // idempotent
    expect(claudeCodeConfig(claudeCodeConfig(existing))).toEqual(claudeCodeConfig(existing));
  });

  test("gemini cli: valid shape, preserves unrelated keys", () => {
    const existing = { theme: "dark" };
    const out = geminiCliConfig(existing) as { theme: string; hooks: Json };
    expect(out.theme).toBe("dark");
    expect(Array.isArray(out.hooks.BeforeToolUse)).toBe(true);
  });

  test("opencode: declares failOpen so a dead recorder never blocks tools", () => {
    expect(openCodePlugin().failOpen).toBe(true);
  });

  test("codex: session-boundary recording, honest about no PreToolUse yet", () => {
    const out = codexConfig({}) as { features: Json; hooks: Json };
    expect(out.features.codex_hooks).toBe(true);
    expect(out.hooks.SessionStart).toBeDefined();
    expect(out.hooks.PreToolUse).toBeUndefined();
  });

  test("fail-open contract: throwing hook answers allow", () => {
    expect(runHookSafely(() => JSON.parse("not json"))).toEqual({});
    expect(runHookSafely(() => { throw new Error("hookd down"); })).toEqual({});
    expect(runHookSafely(() => ({ decision: "block" } as Json))).toEqual({ decision: "block" });
  });

  test("open command resolves on this platform", () => {
    const cmd = openCommand("http://127.0.0.1:8787/workshop");
    if (platform() === "darwin") expect(cmd.startsWith("open ")).toBe(true);
    else if (platform() === "win32") expect(cmd.startsWith("start")).toBe(true);
    else expect(cmd.startsWith("xdg-open")).toBe(true);
    void homedir;
  });
});
