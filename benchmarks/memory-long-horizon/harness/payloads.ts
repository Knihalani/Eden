/**
 * Hook payloads exactly as Claude Code 2.1.285 sends them: the same fields, in the same order, as the payloads
 * a probe plugin captured from real sessions (fixtures/payload-keys.claude-2.1.285.json), and as the hooks
 * reference documents (docs/memory-ship/research/sources/claude-code-hooks.2026-09-29.md, R0).
 *
 * Common fields follow three rules seen in the capture:
 * - `prompt_id` appears once the process has had a prompt, on every event (absent at startup and on resume);
 * - `permission_mode` appears on UserPromptSubmit and on the tool-context events (tool events, Stop,
 *   SubagentStop), and `effort` on the tool-context events only;
 * - inside a subagent, `agent_id` and `agent_type` follow `permission_mode` (SubagentStart has neither of the
 *   other two).
 */
import { toolResultContent, type ToolCall } from "./tools";

/** The hook events the simulator fires. Claude Code has more (FileChanged, CwdChanged, …) that it does not model. */
export const HOOK_EVENTS = [
  "SessionStart",
  "InstructionsLoaded",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type PermissionMode = "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type SessionSource = "startup" | "resume" | "clear" | "compact" | "fork";
export type CompactTrigger = "manual" | "auto";
export type SessionEndReason = "clear" | "resume" | "logout" | "prompt_input_exit" | "other";
export type LoadReason = "session_start" | "nested_traversal" | "path_glob_match" | "include" | "compact";
export type MemoryType = "User" | "Project" | "Local" | "Managed";

export type HookPayload = { hook_event_name: HookEvent } & Record<string, unknown>;

/** Where an event fires: the session, and the subagent when it fires inside one. */
export interface EventContext {
  sessionId: string;
  /** Always the main transcript, also inside a subagent (R0 F27). */
  transcriptPath: string;
  cwd: string;
  /** The prompt being processed; undefined until the process's first prompt. */
  promptId?: string;
  permissionMode: PermissionMode;
  /** Undefined when the model does not support the effort parameter. */
  effort?: EffortLevel;
  agent?: { id: string; type: string };
}

export interface BackgroundTask {
  id: string;
  type: string;
  status: string;
  description: string;
  agent_type?: string;
}

export interface SessionCron {
  id: string;
  schedule: string;
  recurring: boolean;
  prompt: string;
}

export interface StopFields {
  lastAssistantMessage: string;
  stopHookActive?: boolean;
  backgroundTasks?: BackgroundTask[];
  sessionCrons?: SessionCron[];
}

/** Sent on `resume` and `fork` when the transcript holds a response from Claude (v2.1.251+). */
export interface ResumeCost {
  secondsSinceLastResponse: number;
  contextTokens: number;
  promptCacheLikelyExpired: boolean;
  estimatedCacheWriteUsd: number;
}

export interface InstructionsLoad {
  filePath: string;
  memoryType: MemoryType;
  loadReason: LoadReason;
  globs?: string[];
  triggerFilePath?: string;
  parentFilePath?: string;
}

/** Which optional common fields an event carries. */
interface Parts {
  permission: boolean;
  agent: boolean;
  effort: boolean;
}

function common(ctx: EventContext, event: HookEvent, parts: Parts): Record<string, unknown> {
  const out: Record<string, unknown> = {
    session_id: ctx.sessionId,
    transcript_path: ctx.transcriptPath,
    cwd: ctx.cwd,
  };
  if (ctx.promptId !== undefined) out.prompt_id = ctx.promptId;
  if (parts.permission) out.permission_mode = ctx.permissionMode;
  if (parts.agent && ctx.agent) {
    out.agent_id = ctx.agent.id;
    out.agent_type = ctx.agent.type;
  }
  if (parts.effort && ctx.effort) out.effort = { level: ctx.effort };
  out.hook_event_name = event;
  return out;
}

function payload(ctx: EventContext, event: HookEvent, parts: Parts, fields: Record<string, unknown>): HookPayload {
  return { ...common(ctx, event, parts), ...fields } as HookPayload;
}

const SESSION: Parts = { permission: false, agent: false, effort: false };
const PROMPT: Parts = { permission: true, agent: false, effort: false };
const TURN: Parts = { permission: true, agent: false, effort: true };
const TOOL: Parts = { permission: true, agent: true, effort: true };
const SUBAGENT_START: Parts = { permission: false, agent: true, effort: false };
/** A lazy InstructionsLoaded (`nested_traversal`, `path_glob_match`) carries `effort` (captured on 2.1.294). */
const LAZY_LOAD: Parts = { permission: false, agent: false, effort: true };

export function sessionStartPayload(
  ctx: EventContext,
  source: SessionSource,
  extra: { model?: string; resumeCost?: ResumeCost } = {},
): HookPayload {
  const fields: Record<string, unknown> = { source };
  if (extra.model) fields.model = extra.model;
  if (extra.resumeCost) {
    fields.seconds_since_last_response = extra.resumeCost.secondsSinceLastResponse;
    fields.context_tokens = extra.resumeCost.contextTokens;
    fields.prompt_cache_likely_expired = extra.resumeCost.promptCacheLikelyExpired;
    fields.estimated_cache_write_usd = extra.resumeCost.estimatedCacheWriteUsd;
  }
  return payload(ctx, "SessionStart", SESSION, fields);
}

export function instructionsLoadedPayload(ctx: EventContext, load: InstructionsLoad): HookPayload {
  const fields: Record<string, unknown> = {
    file_path: load.filePath,
    memory_type: load.memoryType,
    load_reason: load.loadReason,
  };
  if (load.globs) fields.globs = load.globs;
  if (load.triggerFilePath) fields.trigger_file_path = load.triggerFilePath;
  if (load.parentFilePath) fields.parent_file_path = load.parentFilePath;
  const lazy = load.loadReason === "nested_traversal" || load.loadReason === "path_glob_match";
  return payload(ctx, "InstructionsLoaded", lazy ? LAZY_LOAD : SESSION, fields);
}

export function userPromptSubmitPayload(ctx: EventContext, prompt: string): HookPayload {
  return payload(ctx, "UserPromptSubmit", PROMPT, { prompt });
}

export function preToolUsePayload(ctx: EventContext, call: ToolCall): HookPayload {
  return payload(ctx, "PreToolUse", TOOL, { tool_name: call.name, tool_input: call.input, tool_use_id: call.id });
}

/** PostToolUse carries the tool's structured response; only for a call that succeeded. */
export function postToolUsePayload(ctx: EventContext, call: ToolCall): HookPayload {
  if (!call.result.ok) throw new Error(`PostToolUse for failed call ${call.id}; use PostToolUseFailure`);
  return payload(ctx, "PostToolUse", TOOL, {
    tool_name: call.name,
    tool_input: call.input,
    tool_response: call.result.response,
    tool_use_id: call.id,
    duration_ms: call.durationMs,
  });
}

export function postToolUseFailurePayload(ctx: EventContext, call: ToolCall): HookPayload {
  if (call.result.ok) throw new Error(`PostToolUseFailure for successful call ${call.id}`);
  return payload(ctx, "PostToolUseFailure", TOOL, {
    tool_name: call.name,
    tool_input: call.input,
    tool_use_id: call.id,
    error: call.result.error,
    is_interrupt: call.result.isInterrupt,
    duration_ms: call.durationMs,
  });
}

/** One PostToolBatch per batch; each `tool_response` is the serialized result the model sees. */
export function postToolBatchPayload(ctx: EventContext, calls: readonly ToolCall[]): HookPayload {
  const toolCalls = calls.map((call) => ({
    tool_name: call.name,
    tool_input: call.input,
    tool_use_id: call.id,
    tool_response: toolResultContent(call),
  }));
  return payload(ctx, "PostToolBatch", TOOL, { tool_calls: toolCalls });
}

/** No task prompt: SubagentStart carries only the agent's id and type (R0 F27). */
export function subagentStartPayload(ctx: EventContext): HookPayload {
  if (!ctx.agent) throw new Error("SubagentStart outside a subagent");
  return payload(ctx, "SubagentStart", SUBAGENT_START, {});
}

function stopFields(stop: StopFields): Record<string, unknown> {
  return {
    stop_hook_active: stop.stopHookActive ?? false,
    last_assistant_message: stop.lastAssistantMessage,
    background_tasks: stop.backgroundTasks ?? [],
    session_crons: stop.sessionCrons ?? [],
  };
}

export function subagentStopPayload(
  ctx: EventContext,
  stop: StopFields & { agentTranscriptPath: string },
): HookPayload {
  if (!ctx.agent) throw new Error("SubagentStop outside a subagent");
  const { stop_hook_active, ...rest } = stopFields(stop);
  return payload(ctx, "SubagentStop", TOOL, {
    stop_hook_active,
    agent_transcript_path: stop.agentTranscriptPath,
    ...rest,
  });
}

export function stopPayload(ctx: EventContext, stop: StopFields): HookPayload {
  return payload(ctx, "Stop", TURN, stopFields(stop));
}

export function preCompactPayload(
  ctx: EventContext,
  trigger: CompactTrigger,
  customInstructions: string | null,
): HookPayload {
  return payload(ctx, "PreCompact", SESSION, { trigger, custom_instructions: customInstructions });
}

export function postCompactPayload(ctx: EventContext, trigger: CompactTrigger, compactSummary: string): HookPayload {
  return payload(ctx, "PostCompact", SESSION, { trigger, compact_summary: compactSummary });
}

export function sessionEndPayload(ctx: EventContext, reason: SessionEndReason): HookPayload {
  return payload(ctx, "SessionEnd", SESSION, { reason });
}
