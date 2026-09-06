/**
 * Headless host that simulates Claude Code PostToolUse application (R1).
 *
 * Apply `updatedToolOutput` only when it matches the native schema for a
 * built-in. Otherwise keep the original (silent drop). Always keep
 * `additionalContext` (R3), including under `decision: "block"`.
 *
 * OpenCode / Codex / Gemini apply* helpers are the same replacement landing
 * on each host's channel — or an honest additionalContext degrade with the
 * drop classed.
 */
import {
  capMerged,
  isBuiltInTool,
  isMcpShapedOutput,
  mapHostToolName,
  matchesNativeShape,
  nativeTextOf,
  type TOOL_SHAPES,
} from "./shapes";

export type HookResponse = {
  decision?: string;
  ok?: boolean;
  hookSpecificOutput?: {
    hookEventName?: string;
    additionalContext?: string;
    updatedToolOutput?: unknown;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
  additionalContext?: string;
};

export type AppliedHook = {
  /** Tool result the model sees after the host applies (or drops) the rewrite. */
  visible: unknown;
  /** Always populated from the hook payload when present — survives a dropped rewrite. */
  additionalContext: string;
  droppedRewrite: boolean;
};

function additionalOf(hook: HookResponse | null | undefined): string {
  if (!hook) return "";
  const inner = hook.hookSpecificOutput?.additionalContext;
  if (typeof inner === "string") return inner;
  if (typeof hook.additionalContext === "string") return hook.additionalContext;
  return "";
}

function rewriteOf(hook: HookResponse | null | undefined): unknown {
  return hook?.hookSpecificOutput?.updatedToolOutput;
}

/**
 * Simulate Claude Code applying a PostToolUse hook to a tool result.
 *
 * Built-ins: object rewrite lands iff it matches the native schema; a string
 * rewrite is dropped. Unknown / MCP tools are unvalidated — any rewrite lands.
 * `additionalContext` is always returned, even when the rewrite is dropped or
 * `decision` is `"block"`.
 */
export function applyHookOutput(
  toolName: string,
  original: unknown,
  hookResponse: HookResponse | null | undefined,
): AppliedHook {
  const additionalContext = additionalOf(hookResponse);
  const rewrite = rewriteOf(hookResponse);
  if (rewrite === undefined) {
    return { visible: original, additionalContext, droppedRewrite: false };
  }
  const builtIn = isBuiltInTool(toolName);
  const ok = builtIn ? matchesNativeShape(toolName, rewrite) : true;
  if (!ok) {
    return { visible: original, additionalContext, droppedRewrite: true };
  }
  return { visible: rewrite, additionalContext, droppedRewrite: false };
}

/** Concatenate native text + additionalContext — what a model can actually read. */
export function modelVisibleText(toolName: string, applied: AppliedHook): string {
  const body = nativeTextOf(mapHostToolName(toolName), applied.visible);
  return applied.additionalContext ? `${body}\n${applied.additionalContext}` : body;
}

function attemptedRewrite(hook: HookResponse | null | undefined): boolean {
  return rewriteOf(hook) !== undefined || additionalOf(hook).length > 0;
}

function unwrapOpenCodeOutput(original: unknown): unknown {
  if (!original || typeof original !== "object" || Array.isArray(original)) return original;
  const o = original as { title?: unknown; output?: unknown; metadata?: unknown };
  if ("output" in o && ("title" in o || "metadata" in o)) return o.output;
  return original;
}

function stringLand(mapped: string, original: unknown, hook: HookResponse | null | undefined): string | undefined {
  const rewrite = rewriteOf(hook);
  const extra = additionalOf(hook);
  if (typeof rewrite === "string") return rewrite;
  if (rewrite !== undefined) {
    const text = nativeTextOf(mapped, rewrite);
    if (text) return text;
  }
  const orig =
    typeof original === "string"
      ? original
      : nativeTextOf(mapped, original) || (typeof unwrapOpenCodeOutput(original) === "string" ? (unwrapOpenCodeOutput(original) as string) : "");
  if (extra) return orig ? capMerged(orig, `\n${extra}`) : extra;
  return undefined;
}

/**
 * OpenCode `tool.execute.after`: plugins mutate `output.output` (string) in
 * place. Native tools: that mutation is what the model reads.
 *
 * MCP-shaped after payload `{ content: [{type,text}] }` is assembled AFTER the
 * hook (issue #25918). Mutating `output.output` is dropped. `additionalContext`
 * / `output.inject` still travel so remainder deny and the degrade path hold.
 */
export function applyOpenCodeAfter(
  tool: string,
  originalOutput: unknown,
  hookResult: HookResponse | null | undefined,
): AppliedHook {
  const additionalContext = additionalOf(hookResult);
  const mapped = mapHostToolName(tool);
  const inner = unwrapOpenCodeOutput(originalOutput);
  if (isMcpShapedOutput(inner) || isMcpShapedOutput(originalOutput)) {
    return {
      visible: originalOutput,
      additionalContext,
      droppedRewrite: attemptedRewrite(hookResult),
    };
  }
  const landed = stringLand(mapped, inner, hookResult);
  if (landed === undefined) {
    return { visible: originalOutput, additionalContext, droppedRewrite: false };
  }
  return { visible: landed, additionalContext, droppedRewrite: false };
}

/**
 * Mutate an OpenCode after-hook `output` in place. Native: write the landed
 * string into `output.output`. MCP-shaped: leave `output.output` alone (host
 * drops that mutation) and set `output.inject` when that field exists.
 */
export function applyOpenCodeHostOutput(
  output: { output?: unknown; inject?: unknown },
  tool: string,
  hookResult: HookResponse | null | undefined,
): AppliedHook {
  const applied = applyOpenCodeAfter(tool, output.output, hookResult);
  if (applied.droppedRewrite) {
    if (Object.prototype.hasOwnProperty.call(output, "inject") && applied.additionalContext) {
      output.inject = applied.additionalContext;
    }
    return applied;
  }
  if (typeof applied.visible === "string") output.output = applied.visible;
  return applied;
}

/**
 * Codex `post_tool` command stdout is Claude-like PostToolUse JSON
 * (`postToolUseReplacement`). Object originals follow R1. String originals
 * (Codex `tool_response` is a string) land the rewrite's model-visible text.
 * Glob has no text field — additionalContext degrade, drop classed.
 */
export function applyCodexAfter(
  tool: string,
  original: unknown,
  hookResult: HookResponse | null | undefined,
): AppliedHook {
  const mapped = mapHostToolName(tool);
  if (typeof original === "string") {
    const additionalContext = additionalOf(hookResult);
    const rewrite = rewriteOf(hookResult);
    if (rewrite === undefined) {
      return { visible: original, additionalContext, droppedRewrite: false };
    }
    const text = typeof rewrite === "string" ? rewrite : nativeTextOf(mapped, rewrite);
    if (text) return { visible: text, additionalContext, droppedRewrite: false };
    return { visible: original, additionalContext, droppedRewrite: true };
  }
  return applyHookOutput(mapped, original, hookResult);
}

/**
 * Gemini AfterTool / AfterToolUse: `hookSpecificOutput.additionalContext` is
 * appended to the tool result. `updatedToolOutput` is not a Gemini field —
 * the structured rewrite is dropped and classed. Sentinel still reaches the
 * model via additionalContext (R3).
 */
export function applyGeminiAfter(
  tool: string,
  original: unknown,
  hookResult: HookResponse | null | undefined,
): AppliedHook {
  const additionalContext = additionalOf(hookResult);
  const rewrite = rewriteOf(hookResult);
  void tool;
  return {
    visible: original,
    additionalContext,
    droppedRewrite: rewrite !== undefined,
  };
}

export type { TOOL_SHAPES };
