/**
 * The simulator: drives a Claude Code session step by step. Each step writes the transcript lines Claude
 * Code would write and fires the hook events it would fire, in the captured order
 * (fixtures/payload-keys.claude-2.1.285.json `formats.event_order`), each handler in a fresh process.
 * What a hook returns acts on the session as it would in Claude Code: `additionalContext` is saved to the
 * transcript as a `hook_additional_context` attachment, a blocked prompt never reaches the transcript, and a
 * denied or declined tool call does not run.
 *
 * It also keeps the evaluation's oracle files (A5 §3.4–3.6): the world oracle, the simulated context window of
 * every window, each annotated cue with the window at that moment, and every context the model received.
 *
 * Simplifications, all deliberate:
 * - events are serialized, except a parallel batch of concurrency-safe calls (Read), whose PreToolUse and
 *   PostToolUse hooks run concurrently, as Claude Code runs them;
 * - a background subagent launches in one step and completes in a later one (`completeBackground`), so it is
 *   in `background_tasks` in between; its events do not interleave with the main thread's;
 * - a hook cannot keep the agent going: Stop and SubagentStop continuations (exit 2, `decision: "block"`,
 *   `additionalContext`) and a PostToolBatch block are recorded in the event log but not acted on;
 * - time is a simulated clock; context size is estimated at 4 characters per token of conversation text, with
 *   the run directory counted as a fixed placeholder. Hook-injected context is not counted: a hook's answer
 *   acts on the session only through control flow (a block, a denial) and the transcript, so a plugin whose
 *   text varies between runs cannot change the payloads that follow, nor can where a run lives. Every value
 *   built from the estimate leaves it out: SessionStart(resume) `context_tokens` and
 *   `estimated_cache_write_usd`, the Agent result's `totalTokens`, a task notification's
 *   `<subagent_tokens>`, `message.usage`, and `compactMetadata.preTokens`.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Cue, CueRecord } from "./cues";
import { Oracle, type Effect, type Subject } from "./oracle";
import {
  instructionsLoadedPayload,
  postCompactPayload,
  postToolBatchPayload,
  postToolUseFailurePayload,
  postToolUsePayload,
  preCompactPayload,
  preToolUsePayload,
  sessionEndPayload,
  sessionStartPayload,
  stopPayload,
  subagentStartPayload,
  subagentStopPayload,
  userPromptSubmitPayload,
  type BackgroundTask,
  type CompactTrigger,
  type EffortLevel,
  type EventContext,
  type HookEvent,
  type HookPayload,
  type MemoryType,
  type PermissionMode,
  type SessionEndReason,
} from "./payloads";
import { agentId, hashString, projectSlug, Rng, toolUseId, uuidV4 } from "./rng";
import { HookRunner, hookEnv, type Invocation, type Plugin } from "./runner";
import { agentCall, toolResultContent, type AgentLaunch, type ToolCall } from "./tools";
import { Transcript, type OriginKind, type Usage } from "./transcript";
import { SimulatedWindow, type WindowSnapshot } from "./window";

export const CLAUDE_CODE_VERSION = "2.1.285";
export const MODEL = "claude-opus-5-5";
/** System prompt, tools and instructions at session start, before the first prompt. */
export const BASE_CONTEXT_TOKENS = 20_000;
const SIM_EPOCH = Date.parse("2026-09-01T09:00:00.000Z");

/** Claude Code's text when the user declines a permission prompt (seen in this machine's transcripts). */
export const DECLINED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, " +
  "the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how " +
  "to proceed.";

/**
 * Subagent types whose context omits the project's instruction files. Observed in Claude Code 2.1.285 on
 * 2026-10-03, one headless session each, from the subagent's own report of a marker placed in CLAUDE.md: a
 * general-purpose subagent saw it, Explore and Plan subagents did not. No InstructionsLoaded fired inside any.
 */
const OMITS_INSTRUCTIONS = new Set(["Explore", "Plan"]);

/**
 * Subagent types that start with the parent's context, its packets included (A4 §5.3: "a fork subagent inherits
 * the parent's context"). Simulated, not captured: Claude Code 2.1.285 rejects `subagent_type: "fork"` ("Agent type
 * 'fork' not found", 2026-10-04), so no real fork launch exists to record.
 */
const INHERITS_CONTEXT = new Set(["fork"]);

/** Tools Claude Code runs concurrently within one batch; the others run one after another. */
const CONCURRENT_TOOLS = new Set(["Read"]);

export function tokensOf(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface InstructionFile {
  /** Relative to the project. */
  path: string;
  memoryType: MemoryType;
}

export interface WorldOptions {
  runDir: string;
  plugin: Plugin;
  seed: number;
  /**
   * `lagging` (default): the lines a step writes reach the file after that step's hooks ran, the usual case
   * for a transcript that lags (R0 F8). `eager`: every line is on disk before the next hook runs.
   */
  flush?: "lagging" | "eager";
  permissionMode?: PermissionMode;
  /** null: the model does not support effort, so no `effort` field. */
  effort?: EffortLevel | null;
  /** The user's answer when a hook's `ask` reaches a permission prompt. */
  askAnswer?: "approve" | "decline";
  /** Extra environment for hook processes, e.g. a flag under test. */
  env?: Record<string, string>;
  /** Project files, committed on `main` before the session starts. */
  projectFiles?: Record<string, string>;
  instructions?: InstructionFile[];
  /** The world's subjects (A5 §3.4); a run without them has an empty oracle. */
  subjects?: readonly Subject[];
  /** The world's truth when the run starts. */
  initialTruth?: readonly Effect[];
  /** The repo's directory under the run directory (default `project`). Worlds in one run directory share a home. */
  projectName?: string;
  /**
   * Hands every hook the simulated clock as `EDEN_NOW` (epoch milliseconds), so a product whose clock honours it
   * sees the days a script skips. Off by default: no hook of a plain replay gets it.
   */
  clockEnv?: boolean;
  /**
   * The simulated clock, when worlds that share a home must share one too (a store's writers see one time). A world
   * given none keeps its own, starting at the simulation epoch.
   */
  clock?: SimClock;
}

/** Simulated time in epoch milliseconds, shared by the worlds that hold it. */
export interface SimClock {
  ms: number;
}

/** A fresh simulated clock at the simulation epoch. */
export function simClock(): SimClock {
  return { ms: SIM_EPOCH };
}

/** Where a session runs: its working directory (the repo, or one of its worktrees) and that checkout's branch. */
export interface SessionPlace {
  cwd: string;
  gitBranch: string;
}

export interface EventRecord {
  seq: number;
  event: HookEvent;
  sessionId: string;
  /** `main`, or the subagent's `agent_id`. */
  window: string;
  payload: HookPayload;
  invocations: Invocation[];
  /** On UserPromptSubmit: who sent the submit, as the simulator knows it (hooks must infer it, D24). */
  submit?: OriginKind;
}

/** A context the model received (a hook's `additionalContext`), with the window it landed in. */
export interface Delivery {
  /** The event that returned it. */
  seq: number;
  event: HookEvent;
  sessionId: string;
  window: string;
  content: string;
  /** The window just before this event's contexts arrived. */
  seen: WindowSnapshot;
  /** The scope the window's turn is in: its latest annotated cue's. */
  scope: string;
  /** Index into `SimWorld.cues`, when the packet answers an annotated cue. */
  cue?: number;
  /** Who sent the submit, for a UserPromptSubmit packet. */
  submit?: OriginKind;
}

/** What a scripted human prompt brings besides its text: its annotation, and the truth it changes. */
export interface PromptNote {
  cue?: Cue;
  sets?: readonly Effect[];
}

const DEFAULT_PROJECT: Record<string, string> = {
  "CLAUDE.md": "# Project\n\nA TypeScript monorepo: apps/web and packages/cli.\n",
  "README.md": "# demo\n",
  "package.json": '{ "name": "demo", "private": true, "workspaces": ["apps/*", "packages/*"] }\n',
};

/** Everything one simulation touches: the run directory, the hook runner, the clock, and the event log. */
export class SimWorld {
  /** The run directory's real path (macOS temp dirs sit behind a symlink), so paths match a hook's `$PWD`. */
  readonly runDir: string;
  readonly home: string;
  readonly projectDir: string;
  readonly log: EventRecord[] = [];
  /** Ids that appear in payloads; kept apart from transcript line uuids so hook output cannot shift them. */
  readonly ids: Rng;
  readonly oracle: Oracle;
  readonly deliveries: Delivery[] = [];
  readonly cues: CueRecord[] = [];
  /** Tool calls the script marks as breaking policies, by `tool_use_id` (A5 `guard_recall`). */
  readonly violations = new Map<string, readonly string[]>();
  private readonly runner: HookRunner;
  private readonly records = new WeakMap<Invocation[], EventRecord>();
  private readonly clock: SimClock;

  constructor(readonly options: WorldOptions) {
    this.runDir = realpathSync(options.runDir);
    this.clock = options.clock ?? simClock();
    this.home = join(this.runDir, "home");
    this.projectDir = join(this.runDir, options.projectName ?? "project");
    this.ids = new Rng(options.seed ^ 0x5eed1d5);
    createProject(this.projectDir, this.home, options.projectFiles ?? DEFAULT_PROJECT);
    this.oracle = new Oracle(options.subjects ?? []);
    this.oracle.apply(options.initialTruth ?? [], "init", this.at());
    mkdirSync(join(this.home, ".claude", "plugins", "data", options.plugin.name), { recursive: true });
    this.runner = new HookRunner({
      plugin: options.plugin,
      env: hookEnv({ home: this.home, projectDir: this.projectDir, plugin: options.plugin, extra: options.env }),
      projectDir: this.projectDir,
    });
  }

  get permissionMode(): PermissionMode {
    return this.options.permissionMode ?? "default";
  }

  get effort(): EffortLevel | undefined {
    return this.options.effort === null ? undefined : (this.options.effort ?? "xhigh");
  }

  /** Simulated time, in epoch milliseconds. */
  get timeMs(): number {
    return this.clock.ms;
  }

  now(): string {
    return new Date(this.clock.ms).toISOString();
  }

  /** The position of the next event, and the time: from here on, a change to the truth holds. */
  at(): { seq: number; t: number } {
    return { seq: this.log.length, t: this.clock.ms };
  }

  advance(ms: number): void {
    this.clock.ms += Math.round(ms);
  }

  /** The token estimate of text the model sees, with the run directory counted as a fixed placeholder. */
  tokens(text: string): number {
    return tokensOf(text.replaceAll(this.runDir, "<run>"));
  }

  /** The main checkout, on `main`: where a session runs unless it is started in a worktree. */
  get mainCheckout(): SessionPlace {
    return { cwd: this.projectDir, gitBranch: "main" };
  }

  transcriptPath(sessionId: string, cwd = this.projectDir): string {
    return join(this.home, ".claude", "projects", projectSlug(cwd), `${sessionId}.jsonl`);
  }

  /** A transcript whose line uuids come from their own stream, seeded by its session and window, not its path. */
  transcript(path: string, sessionId: string, agentId?: string, place = this.mainCheckout): Transcript {
    const seed = hashString(`${sessionId}/${agentId ?? "main"}`, this.options.seed);
    const envelope = { sessionId, cwd: place.cwd, version: CLAUDE_CODE_VERSION, gitBranch: place.gitBranch };
    const eager = this.options.flush === "eager";
    return new Transcript(path, envelope, new Rng(seed), () => this.now(), { agentId, eager });
  }

  /**
   * Runs the event's hooks, with `env` added to their environment. The log entry is taken at dispatch, so
   * concurrent events keep dispatch order.
   */
  async dispatch(payload: HookPayload, window: string, env: Record<string, string> = {}): Promise<Invocation[]> {
    const record: EventRecord = {
      seq: this.log.length,
      event: payload.hook_event_name,
      sessionId: String(payload.session_id),
      window,
      payload,
      invocations: [],
    };
    this.log.push(record);
    const clock: Record<string, string> = this.options.clockEnv ? { EDEN_NOW: String(this.clock.ms) } : {};
    record.invocations = await this.runner.dispatch(payload, { ...clock, ...env });
    this.records.set(record.invocations, record);
    return record.invocations;
  }

  /** The event a `dispatch` result belongs to. */
  recordOf(invocations: Invocation[]): EventRecord {
    const record = this.records.get(invocations);
    if (!record) throw new Error("these invocations did not come from dispatch");
    return record;
  }

  /**
   * A change to the repo that no hook sees (a pull, a lockfile swap by hand): files written (or deleted,
   * for null) and committed, and the truth it changes.
   */
  changeRepo(files: Readonly<Record<string, string | null>>, sets: readonly Effect[]): void {
    for (const [path, content] of Object.entries(files)) {
      const target = join(this.projectDir, path);
      if (content === null) rmSync(target, { force: true });
      else {
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, content);
      }
    }
    commitAll(this.projectDir, this.home, "repo change", this.now());
    this.oracle.apply(sets, "repo", this.at());
  }

  /** A new session (fresh `session_id` and transcript), not started yet; in the main checkout unless `place` says. */
  newSession(place = this.mainCheckout): SimSession {
    return new SimSession(this, uuidV4(this.ids), place);
  }

  /**
   * A git worktree of the project on a new branch, at `rel` inside the main checkout (where Claude Code puts its
   * own, `.claude/worktrees/<name>`), and the place a session started there runs in.
   */
  addWorktree(rel: string, branch: string): SessionPlace {
    const cwd = join(this.projectDir, rel);
    git(this.projectDir, this.home, ["worktree", "add", "-q", "-b", branch, cwd]);
    return { cwd: realpathSync(cwd), gitBranch: branch };
  }
}

function createProject(dir: string, home: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, home, ["init", "-q", "-b", "main"]);
  commitAll(dir, home, "init");
}

function commitAll(dir: string, home: string, message: string, date?: string): void {
  git(dir, home, ["add", "-A"]);
  const dates: Record<string, string> = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  git(dir, home, ["-c", "user.name=sim", "-c", "user.email=sim@example.invalid", "commit", "-q", "-m", message], dates);
}

function git(dir: string, home: string, args: string[], extra: Record<string, string> = {}): void {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...extra };
  const run = Bun.spawnSync(["git", ...args], { cwd: dir, env, stdout: "ignore", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.toString()}`);
}

/** One context window: the main thread or a subagent. Tool batches and assistant text happen here. */
export class Window {
  lastText = "";
  /** Tool calls made in this window, for an Agent call's `totalToolUseCount`. */
  toolCalls = 0;
  /** What the model of this window sees (A5 §3.5). */
  readonly seen = new SimulatedWindow();
  /** The scope the window's turn is in (its latest annotated cue's), for packets that name none. */
  scope = "";
  private contextTokens = BASE_CONTEXT_TOKENS;
  private reportedTokens = 0;
  private readonly tokensAt = new Map<string, number>();

  constructor(
    readonly session: SimSession,
    readonly transcript: Transcript,
    readonly agent?: { id: string; type: string },
  ) {}

  /** `main`, or the subagent's `agent_id`. */
  get name(): string {
    return this.agent?.id ?? "main";
  }

  /** The estimated context size of this window. */
  get tokens(): number {
    return this.contextTokens;
  }

  ctx(): EventContext {
    return this.session.ctx(this.agent);
  }

  /** A line the model sees: counted into the context estimate and added to the simulated window. */
  record(uuid: string, text: string): void {
    this.contextTokens += this.session.world.tokens(text);
    this.tokensAt.set(uuid, this.contextTokens);
    this.seen.add(uuid, text);
  }

  /**
   * A hook's context: in the simulated window, but not in the estimate (see the header), so a plugin's
   * output never changes the payloads that follow.
   */
  receive(uuid: string, context: string): void {
    this.tokensAt.set(uuid, this.contextTokens);
    this.seen.add(uuid, context);
  }

  /** The branch continues from line `uuid` (null: the start of the conversation), as after a rewind. */
  rewindTo(uuid: string | null): void {
    this.contextTokens = (uuid === null ? undefined : this.tokensAt.get(uuid)) ?? BASE_CONTEXT_TOKENS;
    this.seen.rewindTo(uuid);
  }

  /** Compaction: the conversation leaves the context; its summary is recorded next. */
  compact(): void {
    this.contextTokens = BASE_CONTEXT_TOKENS;
    this.seen.compact();
  }

  /** `message.usage` for the next assistant line: the context sent, split into cache read and creation. */
  usage(outputText: string): Usage {
    const usage = {
      input_tokens: 4,
      cache_creation_input_tokens: Math.max(0, this.contextTokens - this.reportedTokens),
      cache_read_input_tokens: this.reportedTokens,
      output_tokens: this.session.world.tokens(outputText),
    };
    this.reportedTokens = this.contextTokens;
    return usage;
  }

  async assistant(text: string): Promise<void> {
    const uuid = this.transcript.assistantText(text, this.session.messageId(), MODEL, this.usage(text));
    this.record(uuid, text);
    this.lastText = text;
    this.session.world.advance(3_000);
    this.session.endStep();
  }

  /** One batch of tool calls from one assistant message, then PostToolBatch. Returns the calls as they ran. */
  async tools(calls: readonly ToolCall[]): Promise<ToolCall[]> {
    if (!calls.length) throw new Error("a tool batch needs at least one call");
    this.toolCalls += calls.length;
    const messageId = this.session.messageId();
    const uses = calls.map((call) => {
      const input = JSON.stringify(call.input);
      const uuid = this.transcript.assistantToolUse(call, messageId, MODEL, this.usage(input));
      this.record(uuid, input);
      return uuid;
    });
    const ran = calls.every((call) => CONCURRENT_TOOLS.has(call.name))
      ? await this.runConcurrently(calls, uses)
      : await this.runOneByOne(calls, uses);
    const batch = await this.session.dispatch(postToolBatchPayload(this.ctx(), ran), this);
    this.session.attach(this, "PostToolBatch", batch, ran.at(-1)!.id);
    this.session.endStep();
    return ran;
  }

  private async runConcurrently(calls: readonly ToolCall[], uses: string[]): Promise<ToolCall[]> {
    const pre = await Promise.all(
      calls.map((call) => this.session.dispatch(preToolUsePayload(this.ctx(), call), this)),
    );
    const ran = calls.map((call, i) => this.session.permit(call, pre[i]!));
    const post = await Promise.all(ran.map((call, i) => this.afterRun(call, calls[i]!)));
    ran.forEach((call, i) => this.writeResult(call, uses[i]!, pre[i]!, post[i]!));
    this.session.world.advance(Math.max(...ran.map((call) => call.durationMs)) + 1_500);
    return ran;
  }

  private async runOneByOne(calls: readonly ToolCall[], uses: string[]): Promise<ToolCall[]> {
    const ran: ToolCall[] = [];
    for (const [i, original] of calls.entries()) {
      const pre = await this.session.dispatch(preToolUsePayload(this.ctx(), original), this);
      const call = this.session.permit(original, pre);
      this.writeResult(call, uses[i]!, pre, await this.afterRun(call, original));
      this.session.world.advance(call.durationMs + 1_500);
      ran.push(call);
    }
    return ran;
  }

  /** PostToolUse or PostToolUseFailure; neither fires for a call that a permission decision stopped. */
  private async afterRun(call: ToolCall, original: ToolCall): Promise<PostEvent> {
    if (call !== original) return { event: "PostToolUse", invocations: [] };
    if (call.result.ok) {
      const invocations = await this.session.dispatch(postToolUsePayload(this.ctx(), call), this);
      return { event: "PostToolUse", invocations };
    }
    const invocations = await this.session.dispatch(postToolUseFailurePayload(this.ctx(), call), this);
    return { event: "PostToolUseFailure", invocations };
  }

  /** The result line, then the contexts the call's hooks returned: they land next to the tool result. */
  private writeResult(call: ToolCall, assistantUuid: string, pre: Invocation[], post: PostEvent): void {
    const uuid = this.transcript.toolResult(call, assistantUuid, this.session.promptIdOrThrow());
    this.record(uuid, contentText(call));
    this.session.attach(this, "PreToolUse", pre, call.id);
    this.session.attach(this, post.event, post.invocations, call.id);
  }
}

interface PostEvent {
  event: "PostToolUse" | "PostToolUseFailure";
  invocations: Invocation[];
}

function contentText(call: ToolCall): string {
  const content = toolResultContent(call);
  return typeof content === "string" ? content : content.map((block) => block.text).join("\n");
}

export interface SubagentSpec {
  agentType: string;
  description: string;
  task: string;
  background: boolean;
  report: string;
  /** The annotation of the SubagentStart packet, if the script gives one. */
  cue?: Cue;
}

/** A subagent the Agent tool launched. A background one completes later (`completeBackground`). */
export interface AgentRun {
  launch: AgentLaunch;
  /** The Agent call; once the subagent finished, with its real duration and totals. */
  call: ToolCall;
  window: Window;
}

export class SimSession {
  readonly transcriptPath: string;
  readonly main: Window;
  private promptId?: string;
  /**
   * The human prompts on the current branch since the last compaction: the rewind targets. `said` holds the
   * prompt and the queued prompts of its turn, whose stated truth a rewind past it takes back.
   */
  private readonly humanPrompts: { uuid: string; parent: string | null; said: string[] }[] = [];
  private readonly transcripts = new Set<Transcript>();
  /** Background subagents launched and not completed yet: Stop reports them in `background_tasks`. */
  private readonly background: AgentRun[] = [];

  constructor(
    readonly world: SimWorld,
    readonly sessionId: string,
    readonly place: SessionPlace = world.mainCheckout,
  ) {
    this.transcriptPath = world.transcriptPath(sessionId, place.cwd);
    this.main = new Window(this, this.open(world.transcript(this.transcriptPath, sessionId, undefined, place)));
  }

  ctx(agent?: { id: string; type: string }): EventContext {
    return {
      sessionId: this.sessionId,
      transcriptPath: this.transcriptPath,
      cwd: this.place.cwd,
      promptId: this.promptId,
      permissionMode: this.world.permissionMode,
      effort: this.world.effort,
      agent,
    };
  }

  messageId(): string {
    return `msg_01${this.world.ids.base62(22)}`;
  }

  promptIdOrThrow(): string {
    if (!this.promptId) throw new Error("no prompt yet: a tool call answers a prompt");
    return this.promptId;
  }

  /** Claude Code sets `CLAUDE_PROJECT_DIR` to where the session started, which is a worktree's own directory. */
  dispatch(payload: HookPayload, window: Window): Promise<Invocation[]> {
    return this.world.dispatch(payload, window.name, this.placeEnv());
  }

  private placeEnv(): Record<string, string> {
    return this.place.cwd === this.world.projectDir ? {} : { CLAUDE_PROJECT_DIR: this.place.cwd };
  }

  /** The end of a step: its lines reach the disk (in `lagging` mode; `eager` wrote them already). */
  endStep(): void {
    for (const transcript of this.transcripts) transcript.flush();
  }

  /** Startup or `/clear`: instruction files load, then SessionStart. */
  async start(source: "startup" | "clear" = "startup"): Promise<void> {
    await this.loadInstructions("session_start");
    const invocations = await this.dispatch(sessionStartPayload(this.ctx(), source), this.main);
    this.attach(this.main, "SessionStart", invocations, "SessionStart");
    this.endStep();
  }

  /** `--resume` in a new process: no `prompt_id` until the next prompt, plus the resume-cost fields. */
  async resume(gapSeconds: number): Promise<void> {
    this.promptId = undefined;
    this.world.advance(gapSeconds * 1_000);
    await this.loadInstructions("session_start");
    const contextTokens = this.main.tokens;
    const resumeCost = {
      secondsSinceLastResponse: gapSeconds,
      contextTokens,
      promptCacheLikelyExpired: gapSeconds > 300,
      // $8 per million cache-write tokens: the captured resume reported 0.1816 for 22,700 tokens.
      estimatedCacheWriteUsd: Math.round(contextTokens * 80) / 10_000_000,
    };
    const invocations = await this.dispatch(sessionStartPayload(this.ctx(), "resume", { resumeCost }), this.main);
    this.attach(this.main, "SessionStart", invocations, "SessionStart");
    this.endStep();
  }

  /**
   * A human prompt, typed or queued. False when UserPromptSubmit blocked it, which erases it (and what it
   * said does not become true).
   */
  async prompt(text: string, source: "typed" | "queued" = "typed", note: PromptNote = {}): Promise<boolean> {
    const parent = this.main.transcript.leafUuid;
    const uuid = this.main.transcript.userPrompt(text, this.nextPrompt(), source);
    const submitted = await this.submit({ uuid, parent, prompt: text, kind: "human", note });
    if (submitted) this.humanPrompts.push({ uuid, parent, said: [uuid] });
    return submitted;
  }

  /**
   * The user rewinds to the human prompt at `index` on the current branch and submits `text` in its place.
   * The file stays append-only: the new prompt's parent is the old prompt's parent (R3 E3).
   */
  async rewind(index: number, text: string, note: PromptNote = {}): Promise<boolean> {
    const target = this.humanPrompts[index];
    if (!target) throw new Error(`no human prompt #${index} to rewind to`);
    const abandoned = this.humanPrompts.splice(index).flatMap((prompt) => prompt.said);
    this.world.oracle.abandon(new Set(abandoned), this.world.at());
    this.main.transcript.branchFrom(target.parent);
    this.main.rewindTo(target.parent);
    return this.prompt(text, "typed", note);
  }

  /** A finished background task's notification while the agent is idle: a non-human turn of its own. */
  async taskNotification(run: AgentRun): Promise<boolean> {
    const text = notificationText(run);
    const parent = this.main.transcript.leafUuid;
    const uuid = this.main.transcript.taskNotification(text, this.nextPrompt());
    return this.submit({ uuid, parent, prompt: text, kind: "task-notification" });
  }

  /** A message from another Claude session while the agent is idle. */
  async peerMessage(from: string, body: string): Promise<boolean> {
    const text = peerText(from, body);
    const parent = this.main.transcript.leafUuid;
    const uuid = this.main.transcript.peerMessage(text, from, this.nextPrompt());
    return this.submit({ uuid, parent, prompt: text, kind: "peer" });
  }

  /** A submit that arrives mid-turn: Claude Code records a `queued_command`, then runs UserPromptSubmit. */
  async queued(kind: OriginKind, prompt: string, note: PromptNote = {}): Promise<boolean> {
    const parent = this.main.transcript.leafUuid;
    this.nextPrompt();
    const uuid = this.main.transcript.queuedCommand(prompt, kind);
    const submitted = await this.submit({ uuid, parent, prompt, kind, note });
    if (submitted && kind === "human") this.humanPrompts.at(-1)?.said.push(uuid);
    return submitted;
  }

  async stop(): Promise<void> {
    const stop = { lastAssistantMessage: this.main.lastText, backgroundTasks: this.backgroundTasks() };
    await this.dispatch(stopPayload(this.ctx(), stop), this.main);
    this.world.advance(1_000);
    this.endStep();
  }

  /** The session's running background subagents, as Stop and SubagentStop report them (parent-scoped). */
  private backgroundTasks(): BackgroundTask[] {
    return this.background.map((run) => ({
      id: run.launch.agentId,
      type: "subagent",
      status: "running",
      description: run.launch.description,
      agent_type: run.launch.subagentType,
    }));
  }

  /**
   * An Agent tool call. A foreground subagent runs `body` and reports before the call returns; a background
   * one returns `async_launched` at once and runs when `completeBackground` is called. Null when a
   * permission decision stopped the call.
   */
  async subagent(spec: SubagentSpec, body: (window: Window) => Promise<void>): Promise<AgentRun | null> {
    const id = agentId(this.world.ids);
    const launch: AgentLaunch = {
      description: spec.description,
      prompt: spec.task,
      subagentType: spec.agentType,
      background: spec.background,
      agentId: id,
      report: spec.report,
      outputFile: join(this.world.runDir, "tasks", `${id}.output`),
      toolUses: 0,
      tokens: 0,
    };
    const call = agentCall(toolUseId(this.world.ids), launch, 0);
    const input = JSON.stringify(call.input);
    const use = this.main.transcript.assistantToolUse(call, this.messageId(), MODEL, this.main.usage(input));
    this.main.record(use, input);
    const pre = await this.dispatch(preToolUsePayload(this.ctx(), call), this.main);
    const permitted = this.permit(call, pre);
    if (permitted !== call) {
      await this.finishAgentCall(permitted, use, pre, false);
      return null;
    }

    const childPath = this.subagentTranscriptPath(id);
    const transcript = this.world.transcript(childPath, this.sessionId, id, this.place);
    const child = new Window(this, this.open(transcript), { id, type: spec.agentType });
    child.scope = this.main.scope;
    if (INHERITS_CONTEXT.has(spec.agentType)) child.seen.inherit(this.main.seen.snapshot());
    else if (!OMITS_INSTRUCTIONS.has(spec.agentType)) {
      for (const [path, text] of this.main.seen.instructionFiles) child.seen.loadInstructions(path, text);
    }
    const meta = { agentType: spec.agentType, description: spec.description, toolUseId: call.id, spawnDepth: 1 };
    writeFileSync(childPath.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(meta));
    child.record(child.transcript.taskPrompt(spec.task, this.promptIdOrThrow()), spec.task);
    const started = await this.dispatch(subagentStartPayload(child.ctx()), child);
    const cue = spec.cue && this.noteCue(spec.cue, spec.task, started, child);
    this.attach(child, "SubagentStart", started, "SubagentStart", { cue });

    const run: AgentRun = { launch, call, window: child };
    if (spec.background) {
      this.background.push(run);
      await this.finishAgentCall(call, use, pre, true);
      return run;
    }
    const done = await this.runChild(run, body);
    await this.finishAgentCall(done.call, use, pre, true);
    return done;
  }

  /** A background subagent does its work and stops. Its notification is a separate submit. */
  async completeBackground(run: AgentRun, body: (window: Window) => Promise<void>): Promise<AgentRun> {
    const index = this.background.indexOf(run);
    if (index < 0) throw new Error(`${run.launch.agentId} is not a running background subagent`);
    this.background.splice(index, 1);
    return this.runChild(run, body);
  }

  /**
   * Compaction, in the captured order: PreCompact, the internal compaction agent's SubagentStop (empty
   * `agent_type`, no transcript file), the boundary and summary lines, SessionStart(compact), PostCompact.
   * Instruction files then reload (`load_reason: compact`). False when PreCompact blocked it.
   */
  async compact(trigger: CompactTrigger, summary: string, customInstructions: string | null = null): Promise<boolean> {
    // A manual `/compact` is user input: it gets a prompt id, though no UserPromptSubmit (as captured).
    if (trigger === "manual") this.nextPrompt();
    const pre = await this.dispatch(preCompactPayload(this.ctx(), trigger, customInstructions), this.main);
    if (pre.some((invocation) => invocation.outcome.blocked)) return false;
    const compactor = { id: agentId(this.world.ids), type: "" };
    const stop = {
      lastAssistantMessage: summary,
      agentTranscriptPath: this.subagentTranscriptPath(compactor.id),
      backgroundTasks: this.backgroundTasks(),
    };
    await this.world.dispatch(subagentStopPayload(this.ctx(compactor), stop), compactor.id, this.placeEnv());
    const preTokens = this.main.tokens;
    this.main.compact();
    // Prompts of the compacted conversation are no longer rewind targets (our reading; unverified).
    this.humanPrompts.splice(0);
    this.main.transcript.compactBoundary(trigger, preTokens, BASE_CONTEXT_TOKENS + this.world.tokens(summary), 30_000);
    this.main.record(this.main.transcript.compactSummary(summary, this.promptId), summary);
    this.world.advance(30_000);
    const started = await this.dispatch(sessionStartPayload(this.ctx(), "compact", { model: MODEL }), this.main);
    this.attach(this.main, "SessionStart", started, "SessionStart");
    await this.dispatch(postCompactPayload(this.ctx(), trigger, summary), this.main);
    await this.loadInstructions("compact");
    this.endStep();
    return true;
  }

  async end(reason: SessionEndReason = "other"): Promise<void> {
    await this.dispatch(sessionEndPayload(this.ctx(), reason), this.main);
    this.endStep();
  }

  /** `/clear`: this session ends, and a new one starts with `source: "clear"`. */
  async clear(): Promise<SimSession> {
    await this.end("clear");
    const next = this.world.newSession(this.place);
    await next.start("clear");
    return next;
  }

  /**
   * Applies PreToolUse decisions (precedence deny > defer > ask > allow). An `ask` reaches the user, except
   * that `dontAsk` turns it into a denial and `bypassPermissions` skips it (R0 F26). A stopped call runs
   * nothing; its result is the refusal.
   */
  permit(call: ToolCall, pre: Invocation[]): ToolCall {
    const decisions = new Set(pre.map((invocation) => invocation.outcome.permissionDecision));
    const mode = this.world.permissionMode;
    let refusal: string | undefined;
    if (decisions.has("deny")) refusal = `PreToolUse:${call.name} hook denied this tool call`;
    else if (decisions.has("defer")) refusal = `PreToolUse:${call.name} hook deferred this tool call`;
    else if (decisions.has("ask") && mode === "dontAsk") refusal = `Permission to use ${call.name} was denied`;
    else if (decisions.has("ask") && mode !== "bypassPermissions" && this.world.options.askAnswer === "decline") {
      refusal = DECLINED;
    }
    return refusal === undefined ? call : { ...call, result: { ok: false, error: refusal, isInterrupt: false } };
  }

  /**
   * Saves each handler's `additionalContext` the way Claude Code does: an attachment after the newest line.
   * Each one is also a delivery, scored against the window as it was before this event's contexts.
   */
  attach(
    window: Window,
    event: HookEvent,
    invocations: Invocation[],
    toolUseID: string,
    link: { cue?: number; submit?: OriginKind } = {},
  ): void {
    const contexts = invocations.flatMap((invocation) => invocation.outcome.additionalContext ?? []);
    if (!contexts.length) return;
    const seen = window.seen.snapshot();
    const seq = this.world.recordOf(invocations).seq;
    for (const content of contexts) {
      const id = event === "UserPromptSubmit" ? `hook-${window.transcript.uuid()}` : toolUseID;
      window.receive(window.transcript.hookContext(event, event, id, content), content);
      const at = { seq, event, sessionId: this.sessionId, window: window.name, content, seen, scope: window.scope };
      this.world.deliveries.push({ ...at, ...link });
    }
  }

  /** `<session>/subagents/agent-<id>.jsonl`, next to the main transcript (R0 F27). */
  private subagentTranscriptPath(id: string): string {
    return join(this.transcriptPath.slice(0, -".jsonl".length), "subagents", `agent-${id}.jsonl`);
  }

  private nextPrompt(): { promptId: string; permissionMode: PermissionMode } {
    this.promptId = uuidV4(this.world.ids);
    return { promptId: this.promptId, permissionMode: this.world.permissionMode };
  }

  private open(transcript: Transcript): Transcript {
    this.transcripts.add(transcript);
    return transcript;
  }

  /**
   * Runs UserPromptSubmit for the submit's line, and erases the line if a hook blocked it. Otherwise what the
   * prompt says becomes true from this event on, and its cue is recorded with the window it arrives in.
   */
  private async submit(submit: Submit): Promise<boolean> {
    const { uuid, parent, prompt, kind, note = {} } = submit;
    const t = this.world.timeMs;
    const invocations = await this.dispatch(userPromptSubmitPayload(this.ctx(), prompt), this.main);
    const record = this.world.recordOf(invocations);
    record.submit = kind;
    this.world.advance(2_000);
    if (invocations.some((invocation) => invocation.outcome.blocked)) {
      this.main.transcript.retractLast(uuid, parent);
      this.endStep();
      return false;
    }
    this.world.oracle.apply(note.sets ?? [], "user", { seq: record.seq, t }, uuid);
    this.main.record(uuid, prompt);
    const cue = note.cue && this.noteCue(note.cue, prompt, invocations, this.main);
    this.attach(this.main, "UserPromptSubmit", invocations, "", { cue, submit: kind });
    this.endStep();
    return true;
  }

  /** Records an annotated cue with the window as its packet finds it; the window's turn takes its scope. */
  private noteCue(cue: Cue, text: string, invocations: Invocation[], window: Window): number {
    window.scope = cue.scope;
    const seq = this.world.recordOf(invocations).seq;
    const record = { cue, text, seq, sessionId: this.sessionId, window: window.name, seen: window.seen.snapshot() };
    return this.world.cues.push(record) - 1;
  }

  private async loadInstructions(reason: "session_start" | "compact"): Promise<void> {
    for (const file of this.world.options.instructions ?? DEFAULT_INSTRUCTIONS) {
      const filePath = join(this.place.cwd, file.path);
      this.main.seen.loadInstructions(file.path, existsSync(filePath) ? readFileSync(filePath, "utf8") : "");
      const load = { filePath, memoryType: file.memoryType, loadReason: reason };
      await this.dispatch(instructionsLoadedPayload(this.ctx(), load), this.main);
    }
  }

  /** The subagent's body, its report, then SubagentStop. The Agent call's result gets the real totals. */
  private async runChild(run: AgentRun, body: (window: Window) => Promise<void>): Promise<AgentRun> {
    const startedAt = this.world.timeMs;
    await body(run.window);
    await run.window.assistant(run.launch.report);
    const stop = {
      lastAssistantMessage: run.launch.report,
      agentTranscriptPath: run.window.transcript.path,
      backgroundTasks: this.backgroundTasks(),
    };
    await this.dispatch(subagentStopPayload(run.window.ctx(), stop), run.window);
    this.endStep();
    const launch = { ...run.launch, toolUses: run.window.toolCalls, tokens: run.window.tokens };
    return { ...run, launch, call: agentCall(run.call.id, launch, this.world.timeMs - startedAt) };
  }

  /** PostToolUse (unless stopped), the tool result in the parent, then the parent's PostToolBatch. */
  private async finishAgentCall(call: ToolCall, use: string, pre: Invocation[], ran: boolean): Promise<void> {
    const post = ran ? await this.dispatch(postToolUsePayload(this.ctx(), call), this.main) : [];
    this.main.record(this.main.transcript.toolResult(call, use, this.promptIdOrThrow()), contentText(call));
    this.attach(this.main, "PreToolUse", pre, call.id);
    this.attach(this.main, "PostToolUse", post, call.id);
    this.attach(
      this.main,
      "PostToolBatch",
      await this.dispatch(postToolBatchPayload(this.ctx(), [call]), this.main),
      call.id,
    );
    this.endStep();
  }
}

const DEFAULT_INSTRUCTIONS: InstructionFile[] = [{ path: "CLAUDE.md", memoryType: "Project" }];

interface Submit {
  uuid: string;
  parent: string | null;
  prompt: string;
  kind: OriginKind;
  note?: PromptNote;
}

/** What UserPromptSubmit receives for a peer message; the transcript line adds Claude Code's preface. */
export function peerText(from: string, body: string): string {
  return `<agent-message from="${from}">\n${body}\n</agent-message>`;
}

/** Claude Code's `<task-notification>` for a finished background subagent (2.1.285 shape). */
export function notificationText(run: AgentRun): string {
  const { launch, call } = run;
  return [
    "<task-notification>",
    `<task-id>${launch.agentId}</task-id>`,
    `<tool-use-id>${call.id}</tool-use-id>`,
    `<output-file>${launch.outputFile}</output-file>`,
    "<status>completed</status>",
    `<summary>Agent "${launch.description}" completed</summary>`,
    "<note>A task-notification fires each time this agent stops with no live background children of its own. " +
      "The user can send it another message and resume it, so the same task-id may notify more than once.</note>",
    `<result>${launch.report}</result>`,
    `<usage><subagent_tokens>${launch.tokens}</subagent_tokens><tool_uses>${launch.toolUses}</tool_uses>` +
      `<duration_ms>${call.durationMs}</duration_ms></usage>`,
    "</task-notification>",
  ].join("\n");
}
