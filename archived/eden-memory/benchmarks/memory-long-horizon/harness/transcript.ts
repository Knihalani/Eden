/**
 * A Claude Code session transcript (`~/.claude/projects/<slug>/<session>.jsonl`, or a subagent's
 * `<session>/subagents/agent-<id>.jsonl`), written line by line in the real format: the line kinds, field
 * orders and `parentUuid` chaining of Claude Code 2.1.2xx (fixtures/transcript-keys.claude-2.1.2xx.json,
 * R6 §1.1).
 *
 * Lines are buffered and reach the file only on `flush()`, because the real file "is written asynchronously
 * and may lag the in-memory conversation" (R0 F8); the session decides when to flush.
 */
import { appendFileSync, mkdirSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import { uuidV4, type Rng } from "./rng";
import type { CompactTrigger, HookEvent, PermissionMode } from "./payloads";
import { toolResultContent, toolUseResult, type ToolCall } from "./tools";

/** The fields that close every line of one transcript. */
export interface Envelope {
  sessionId: string;
  cwd: string;
  version: string;
  gitBranch: string;
}

/** `message.usage`: input + cache creation + cache read is the context size, R6's proxy for it. */
export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

/** Who a non-human submit came from (`origin.kind`; D24 keys silence on it at encode time). */
export type OriginKind = "human" | "task-notification" | "peer";

export interface PromptMeta {
  promptId: string;
  permissionMode: PermissionMode;
}

type Line = Record<string, unknown>;

export class Transcript {
  private leaf: string | null = null;
  private pending: { uuid: string; text: string }[] = [];
  private flushedBytes = 0;
  /** The newest line already on disk, and the file size before it, so a blocked prompt can be erased. */
  private lastFlushed?: { uuid: string; offset: number };
  private readonly agentId?: string;
  private readonly eager: boolean;

  constructor(
    readonly path: string,
    private readonly envelope: Envelope,
    private readonly rng: Rng,
    private readonly now: () => string,
    options: {
      /** Set on a subagent's transcript: its lines carry `isSidechain: true` and the `agentId`. */
      agentId?: string;
      /** Write every line at once instead of on `flush()`. */
      eager?: boolean;
    } = {},
  ) {
    this.agentId = options.agentId;
    this.eager = options.eager ?? false;
    mkdirSync(dirname(path), { recursive: true });
  }

  /** The newest line on the current branch: the next line's parent. */
  get leafUuid(): string | null {
    return this.leaf;
  }

  /** Points the next line at an earlier one. A rewind re-submits from the parent of an earlier prompt. */
  branchFrom(uuid: string | null): void {
    this.leaf = uuid;
  }

  /** A fresh uuid from this transcript's stream (Claude Code also ids hook attachments with one). */
  uuid(): string {
    return uuidV4(this.rng);
  }

  flush(): void {
    for (const line of this.pending) {
      this.lastFlushed = { uuid: line.uuid, offset: this.flushedBytes };
      appendFileSync(this.path, line.text);
      this.flushedBytes += Buffer.byteLength(line.text);
    }
    this.pending = [];
  }

  /** Erases the newest line: a prompt that UserPromptSubmit blocked never stays in the transcript. */
  retractLast(uuid: string, parent: string | null): void {
    if (this.pending.at(-1)?.uuid === uuid) this.pending.pop();
    else if (!this.pending.length && this.lastFlushed?.uuid === uuid) {
      truncateSync(this.path, this.lastFlushed.offset);
      this.flushedBytes = this.lastFlushed.offset;
      this.lastFlushed = undefined;
    } else throw new Error(`line ${uuid} is not the newest line`);
    this.leaf = parent;
  }

  userPrompt(text: string, meta: PromptMeta, source: "typed" | "queued"): string {
    return this.append((uuid) => ({
      ...this.head(this.leaf, meta.promptId),
      type: "user",
      message: { role: "user", content: text },
      uuid,
      timestamp: this.now(),
      permissionMode: meta.permissionMode,
      origin: { kind: "human" },
      promptSource: source,
    }));
  }

  taskNotification(text: string, meta: PromptMeta): string {
    return this.append((uuid) => ({
      ...this.head(this.leaf, meta.promptId),
      type: "user",
      message: { role: "user", content: text },
      uuid,
      timestamp: this.now(),
      permissionMode: meta.permissionMode,
      origin: { kind: "task-notification" },
      promptSource: "system",
    }));
  }

  /** A message from another Claude session: a meta line whose text opens with Claude Code's preface. */
  peerMessage(text: string, from: string, meta: PromptMeta): string {
    return this.append((uuid) => ({
      ...this.head(this.leaf, meta.promptId),
      type: "user",
      message: { role: "user", content: `Another Claude session sent a message:\n${text}` },
      isMeta: true,
      uuid,
      timestamp: this.now(),
      permissionMode: meta.permissionMode,
      origin: { kind: "peer", from },
      promptSource: "system",
    }));
  }

  /** The first line of a subagent transcript: its task, with no parent. */
  taskPrompt(task: string, promptId: string): string {
    return this.append((uuid) => ({
      ...this.head(null, promptId),
      type: "user",
      message: { role: "user", content: task },
      uuid,
      timestamp: this.now(),
    }));
  }

  assistantText(text: string, messageId: string, model: string, usage: Usage): string {
    const block = { type: "text", text };
    return this.append((uuid) => this.assistantLine(uuid, messageId, model, block, "end_turn", usage));
  }

  /** One line per `tool_use` block, as Claude Code writes a message with parallel calls. */
  assistantToolUse(call: ToolCall, messageId: string, model: string, usage: Usage): string {
    const block = { type: "tool_use", id: call.id, name: call.name, input: call.input };
    return this.append((uuid) => this.assistantLine(uuid, messageId, model, block, "tool_use", usage));
  }

  /** A tool result, parented on the assistant line that made the call. */
  toolResult(call: ToolCall, assistantUuid: string, promptId: string): string {
    const content = toolResultContent(call);
    const block = call.result.ok
      ? { tool_use_id: call.id, type: "tool_result", content, is_error: false }
      : { type: "tool_result", content, is_error: true, tool_use_id: call.id };
    return this.append((uuid) => ({
      ...this.head(assistantUuid, promptId),
      type: "user",
      message: { role: "user", content: [block] },
      uuid,
      timestamp: this.now(),
      toolUseResult: toolUseResult(call),
      sourceToolAssistantUUID: assistantUuid,
    }));
  }

  /** What Claude Code saves when a hook returns `additionalContext` (R0 F5). */
  hookContext(event: HookEvent, hookName: string, toolUseID: string, content: string): string {
    return this.append((uuid) => ({
      ...this.head(this.leaf),
      attachment: { type: "hook_additional_context", content: [content], hookName, toolUseID, hookEvent: event },
      type: "attachment",
      uuid,
      timestamp: this.now(),
    }));
  }

  /**
   * A nested CLAUDE.md that a tool's file access loaded (`nested_memory`, captured on Claude Code 2.1.294 with its
   * InstructionsLoaded `nested_traversal`): its text is in the context from here, like any line.
   */
  nestedMemory(path: string, displayPath: string, content: string): string {
    return this.append((uuid) => ({
      ...this.head(this.leaf),
      attachment: {
        type: "nested_memory",
        path,
        content: { path, type: "Project", content, contentDiffersFromDisk: false },
        displayPath,
      },
      type: "attachment",
      uuid,
      timestamp: this.now(),
    }));
  }

  /** A submit that arrived while the agent was working (a queued prompt or a background task's notification). */
  queuedCommand(prompt: string, kind: OriginKind): string {
    const commandMode = kind === "task-notification" ? "task-notification" : "prompt";
    return this.append((uuid) => ({
      ...this.head(this.leaf),
      attachment: { type: "queued_command", prompt, commandMode, origin: { kind } },
      type: "attachment",
      uuid,
      timestamp: this.now(),
    }));
  }

  /** The boundary has no parent; `logicalParentUuid` keeps the link to the compacted conversation. */
  compactBoundary(trigger: CompactTrigger, preTokens: number, postTokens: number, durationMs: number): string {
    return this.append((uuid) => ({
      parentUuid: null,
      logicalParentUuid: this.leaf,
      isSidechain: this.agentId !== undefined,
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      level: "info",
      compactMetadata: { trigger, preTokens, durationMs, postTokens },
      uuid,
      timestamp: this.now(),
    }));
  }

  /** `promptId` is absent when auto compaction runs before a resumed process's first prompt. */
  compactSummary(summary: string, promptId: string | undefined): string {
    const content =
      "This session is being continued from a previous conversation that ran out of context. " +
      `The summary below covers the earlier portion of the conversation.\n\n${summary}`;
    return this.append((uuid) => ({
      ...this.head(this.leaf, promptId),
      type: "user",
      message: { role: "user", content },
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      uuid,
      timestamp: this.now(),
    }));
  }

  private assistantLine(
    uuid: string,
    messageId: string,
    model: string,
    block: Record<string, unknown>,
    stopReason: string,
    usage: Usage,
  ): Line {
    return {
      ...this.head(this.leaf),
      message: {
        model,
        id: messageId,
        type: "message",
        role: "assistant",
        content: [block],
        stop_reason: stopReason,
        stop_sequence: null,
        usage,
      },
      type: "assistant",
      uuid,
      timestamp: this.now(),
    };
  }

  /** The opening fields: a subagent's lines carry `agentId` right after `promptId`, as the real files do. */
  private head(parentUuid: string | null, promptId?: string): Line {
    const line: Line = { parentUuid, isSidechain: this.agentId !== undefined };
    if (promptId !== undefined) line.promptId = promptId;
    if (this.agentId !== undefined) line.agentId = this.agentId;
    return line;
  }

  /** Builds the line with a fresh uuid, closes it with the envelope, buffers it and makes it the leaf. */
  private append(build: (uuid: string) => Line): string {
    const uuid = uuidV4(this.rng);
    const line = {
      ...build(uuid),
      userType: "external",
      entrypoint: "cli",
      cwd: this.envelope.cwd,
      sessionId: this.envelope.sessionId,
      version: this.envelope.version,
      gitBranch: this.envelope.gitBranch,
    };
    this.pending.push({ uuid, text: `${JSON.stringify(line)}\n` });
    this.leaf = uuid;
    if (this.eager) this.flush();
    return uuid;
  }
}
