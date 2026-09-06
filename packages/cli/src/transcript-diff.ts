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
  visible: unknown;
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
