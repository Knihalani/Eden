/**
 * R6-shaped sessions (A5 §3.8): a seeded generator writes a session as a plain-data script, and `play`
 * replays the script through the simulator. A script is JSON, so a run can be saved, read and replayed.
 *
 * The generator draws the shape from R6's measurements (research/R6-real-usage.md §2): human prompts per
 * session, context growth per human prompt, tool calls per turn including subagents, and about 8 subagent
 * windows and 1.7 non-human submits per main window. How those split into parts is modelled, not measured;
 * each choice is named where it is made. Prompt and file text is synthetic: no real prompt is ever used.
 *
 * Every human prompt carries its cue annotation (A5 §3.6). A generated prompt needs nothing: a "continue" after
 * a report is an `ack` turn (A7 §2), and a task allows nothing. A world scenario (world.ts) replaces some
 * prompts with statements and annotated cues, and adds repo changes no hook sees.
 */
import { plainCue, type Cue } from "./cues";
import type { Effect } from "./oracle";
import { hashString, Rng, toolUseId, type Knot } from "./rng";
import {
  BASE_CONTEXT_TOKENS,
  notificationText,
  peerText,
  tokensOf,
  type AgentRun,
  type PromptNote,
  type SimSession,
  type SimWorld,
  type Window,
} from "./session";
import { bashCall, editCall, readCall, writeCall, type ToolCall } from "./tools";

export type ToolSpec = (
  | { tool: "Read"; path: string; chars: number; text?: string }
  | { tool: "Edit"; path: string; oldString: string; newString: string }
  | { tool: "Write"; path: string; chars: number }
  | { tool: "Bash"; command: string; description: string; chars: number; exitCode: number; text?: string }
) & {
  /** Policy items (`key@scope`) the call breaks: an annotated guard case (A5 `guard_recall`). */
  violates?: string[];
};

/** A step inside a subagent window. */
export type WindowStep = { kind: "tools"; calls: ToolSpec[] } | { kind: "assistant"; text: string };

/** What a human prompt step carries besides its text: its annotation, and the truth it changes. */
interface Said {
  text: string;
  cue: Cue;
  sets?: Effect[];
}

export type Step =
  | { kind: "start" }
  | ({ kind: "prompt"; source: "typed" | "queued" } & Said)
  /** Re-submit in place of the human prompt at `index` (0-based, current branch): a rewind. */
  | ({ kind: "rewind"; index: number } & Said)
  /** A human prompt typed while the agent works: delivered mid-turn as a `queued_command`. */
  | ({ kind: "queued-prompt" } & Said)
  | WindowStep
  | {
      kind: "subagent";
      ref: string;
      agentType: string;
      description: string;
      task: string;
      background: boolean;
      body: WindowStep[];
      report: string;
      cue?: Cue;
    }
  /** A background subagent finishes (its body runs), then its notification arrives. */
  | { kind: "notify"; ref: string; delivery: "idle" | "mid-turn" }
  | { kind: "peer"; from: string; text: string; delivery: "idle" | "mid-turn" }
  | { kind: "stop" }
  /** `atTokens`: the generator's context estimate when it compacted (A5 §3.8: around 600k). */
  | { kind: "compact"; trigger: "auto" | "manual"; summary: string; atTokens: number }
  | { kind: "end" }
  | { kind: "resume"; gapSeconds: number }
  /** A change to the repo that no hook sees: files written (null: deleted) and committed, and its truth. */
  | { kind: "repo"; files: Record<string, string | null>; sets: Effect[] };

export interface ShapeParams {
  /** R6 §2: human prompts per session, p25 1 / p50 3 / p75 7 / p90 10 / max 24. */
  humanPrompts: readonly Knot[];
  /** R6 §2: context growth per human prompt in tokens, p25 6k / p50 15k / p75 41k / p90 72k. */
  growthTokens: readonly Knot[];
  /** Main-thread tool calls per human turn. Modelled so that, with subagents, R6's p50 of 12 holds. */
  mainToolCalls: readonly Knot[];
  /** Tool calls inside one subagent. Modelled: heavy-tailed, as R6's subagent totals are. */
  subagentToolCalls: readonly Knot[];
  /** Mean subagents per human turn; with R6's prompt counts this gives ~8 subagent windows per session. */
  subagentsPerTurn: number;
  /** Share of turns that launch any subagent; they come in clusters (modelled). */
  subagentTurnShare: number;
  /** Background subagents each produce one task notification; tuned with `peersPerTurn` to R6's 1.7. */
  backgroundShare: number;
  peersPerTurn: number;
  /** R6 §4.2: about a fifth of non-human submits arrive mid-turn (queued). */
  midTurnShare: number;
  /** R3 E3 / A5 §3.8: a rewind or edit in 27% of sessions. */
  rewindShare: number;
  /** R6 §2: 6 of 34 sessions were resumed or cleared; resume modelled at 0.15. */
  resumeShare: number;
  /** Human prompts after the first that arrive queued (`promptSource: queued`): R6 saw 2 of 197. */
  queuedPromptShare: number;
  /** Human prompts after the first typed while the agent works, delivered mid-turn. Modelled. */
  midTurnPromptShare: number;
  /** R6 §3: 13% of human prompts were "continue". */
  chatterShare: number;
  /** Bash calls that fail. Modelled. */
  bashFailureShare: number;
  /** A5 §3.8: compaction around 600k tokens. */
  compactAtTokens: number;
  /** Multiplies every tool call count; 1 is R6. Smaller values keep a CI replay short. */
  toolScale: number;
  /** Multiplies context growth (and so the size of tool output); 1 is R6. */
  growthScale: number;
}

export const R6_SHAPE: ShapeParams = {
  humanPrompts: [
    [0, 1],
    [0.25, 1],
    [0.5, 3],
    [0.75, 7],
    [0.9, 10],
    [1, 24],
  ],
  growthTokens: [
    [0, 1_000],
    [0.25, 6_000],
    [0.5, 15_000],
    [0.75, 41_000],
    [0.9, 72_000],
    [1, 150_000],
  ],
  mainToolCalls: [
    [0, 1],
    [0.25, 2],
    [0.5, 5],
    [0.75, 11],
    [0.9, 25],
    [1, 120],
  ],
  subagentToolCalls: [
    [0, 1],
    [0.25, 3],
    [0.5, 10],
    [0.75, 40],
    [0.9, 150],
    [1, 600],
  ],
  subagentsPerTurn: 1.58,
  subagentTurnShare: 0.35,
  backgroundShare: 0.88,
  peersPerTurn: 0.31,
  midTurnShare: 0.2,
  rewindShare: 0.27,
  resumeShare: 0.15,
  queuedPromptShare: 0.01,
  midTurnPromptShare: 0.01,
  chatterShare: 0.13,
  bashFailureShare: 0.08,
  compactAtTokens: 600_000,
  toolScale: 1,
  growthScale: 1,
};

export interface SessionScript {
  seed: number;
  params: ShapeParams;
  steps: Step[];
}

const FOLDERS = ["apps/web/src", "apps/web/app", "packages/cli/src", "packages/wrap/src", "src", "scripts"] as const;
const FILES = ["index.ts", "auth.ts", "db.ts", "login.ts", "config.ts", "util.ts", "server.ts", "cli.ts"] as const;
const AGENT_TYPES = ["Explore", "Explore", "general-purpose", "general-purpose", "Plan"] as const;
const TASKS = [
  "fix the failing test in {path}",
  "add input validation to {path}",
  "why does `bun test` fail after the change to {path}?",
  "refactor the retry logic in {path}",
  "rename the config loader in {path} and update its callers",
  "the build is broken, can you look at {path}",
  "write a test for the empty-input case in {path}",
  "explain what {path} does",
] as const;
const COMMANDS = [
  ["bun test", "Run the test suite"],
  ["git status", "Show working tree status"],
  ["git diff --stat", "Show changed files"],
  ["bun run typecheck", "Typecheck the workspace"],
  ["ls", "List files"],
] as const;

/** Generates one R6-shaped session. Deterministic: the same seed and params give the same script. */
export function generateSession(seed: number, overrides: Partial<ShapeParams> = {}): SessionScript {
  const params = { ...R6_SHAPE, ...overrides };
  return { seed, params, steps: new Generator(new Rng(seed), params).session() };
}

class Generator {
  private readonly steps: Step[] = [];
  private context = BASE_CONTEXT_TOKENS;
  /** Context size before each human prompt on the current branch, to restore on a rewind. */
  private readonly contextBefore: number[] = [];
  private agents = 0;
  /** Background subagents launched this turn and not yet notified. */
  private pending: string[] = [];
  private idlePeers = 0;

  constructor(
    private readonly rng: Rng,
    private readonly p: ShapeParams,
  ) {}

  session(): Step[] {
    let prompts = Math.max(1, Math.round(this.rng.quantile(this.p.humanPrompts)));
    const rewind = this.rng.chance(this.p.rewindShare);
    if (rewind && prompts === 1) prompts = 2;
    const rewindAt = rewind ? this.rng.int(1, prompts - 1) : -1;
    const resumeAt = prompts > 1 && this.rng.chance(this.p.resumeShare) ? this.rng.int(1, prompts - 1) : -1;
    this.steps.push({ kind: "start" });
    for (let turn = 0; turn < prompts; turn++) {
      if (turn === resumeAt) this.steps.push({ kind: "end" }, { kind: "resume", gapSeconds: this.rng.int(60, 7200) });
      if (this.context >= this.p.compactAtTokens) this.compact();
      this.prompt(turn, turn === rewindAt);
      const next = turn + 1;
      const queueNext =
        next < prompts && next !== rewindAt && next !== resumeAt && this.rng.chance(this.p.midTurnPromptShare);
      this.turn(queueNext);
      if (queueNext) turn++;
      this.idleSubmits();
    }
    this.steps.push({ kind: "end" });
    return this.steps;
  }

  private compact(): void {
    const summary = this.text(4_000, "summary");
    this.steps.push({ kind: "compact", trigger: "auto", summary, atTokens: Math.round(this.context) });
    this.context = BASE_CONTEXT_TOKENS + tokensOf(summary);
    // As in the simulator, prompts of the compacted conversation are no longer rewind targets.
    this.contextBefore.splice(0);
  }

  private prompt(turn: number, rewind: boolean): void {
    const chatter = this.rng.chance(this.p.chatterShare);
    const text = chatter ? "continue" : this.task();
    // Every turn ends on a report (`reply`), never a proposal, so a "continue" is an ack.
    const cue = plainCue("", chatter ? "ack" : undefined);
    // Only prompts on the branch since the last compaction can be rewound to; a mid-turn prompt is not one
    // (it has no prompt line). With none, the rewind does not happen.
    const onBranch = this.contextBefore.length;
    if (rewind && onBranch > 0) {
      const index = this.rng.int(Math.max(0, onBranch - 2), onBranch - 1);
      this.context = this.contextBefore[index]!;
      this.contextBefore.splice(index);
      this.contextBefore.push(this.context);
      this.steps.push({ kind: "rewind", index, text, cue });
    } else {
      this.contextBefore.push(this.context);
      const queued = turn > 0 && this.rng.chance(this.p.queuedPromptShare);
      this.steps.push({ kind: "prompt", text, source: queued ? "queued" : "typed", cue });
    }
    this.context += tokensOf(text);
  }

  /**
   * The agent's work for one human prompt: batches, subagents and mid-turn arrivals, then Stop. With
   * `queueNext`, the next human prompt arrives mid-turn and its work continues in the same run.
   */
  private turn(queueNext: boolean): void {
    this.work();
    if (queueNext) {
      this.steps.push({ kind: "queued-prompt", text: this.task(), cue: plainCue() });
      this.work();
    }
    this.steps.push({ kind: "assistant", text: this.text(300, "reply") });
    this.steps.push({ kind: "stop" });
  }

  private subagentCount(): number {
    if (!this.rng.chance(this.p.subagentTurnShare)) return 0;
    return 1 + this.rng.poisson(this.p.subagentsPerTurn / this.p.subagentTurnShare - 1);
  }

  /** Tool batches, subagents and mid-turn arrivals for one human prompt's worth of work. */
  private work(): void {
    const growth = this.rng.quantile(this.p.growthTokens) * this.p.growthScale;
    const calls = this.scaled(this.rng.quantile(this.p.mainToolCalls));
    const subagents = this.subagentCount();
    const charsPerCall = Math.max(40, Math.round((growth * 4) / calls));
    const batches = this.batches(calls, charsPerCall);
    const launchAt = Array.from({ length: subagents }, () => this.rng.int(0, batches.length));
    const peers = this.rng.poisson(this.p.peersPerTurn);
    const midTurnPeers: number[] = [];
    for (let i = 0; i < peers; i++) {
      if (this.rng.chance(this.p.midTurnShare)) midTurnPeers.push(this.rng.int(0, batches.length - 1));
      else this.idlePeers++;
    }
    for (let b = 0; b <= batches.length; b++) {
      for (const at of launchAt) if (at === b) this.subagent();
      const batch = batches[b];
      if (!batch) continue;
      this.steps.push({ kind: "tools", calls: batch });
      if (this.pending.length && this.rng.chance(this.p.midTurnShare)) {
        this.steps.push({ kind: "notify", ref: this.pending.shift()!, delivery: "mid-turn" });
      }
      for (const at of midTurnPeers) if (at === b) this.steps.push(this.peer("mid-turn"));
    }
    this.context += growth;
  }

  /** Notifications and peer messages that arrive while the agent is idle: each a short non-human turn. */
  private idleSubmits(): void {
    const idle: Step[] = [
      ...this.pending.map((ref): Step => ({ kind: "notify", ref, delivery: "idle" })),
      ...Array.from({ length: this.idlePeers }, () => this.peer("idle")),
    ];
    this.pending = [];
    for (const step of idle)
      this.steps.push(step, { kind: "assistant", text: this.text(200, "ack") }, { kind: "stop" });
    this.idlePeers = 0;
  }

  private peer(delivery: "idle" | "mid-turn"): Step {
    return { kind: "peer", from: this.rng.hex(17), text: this.text(200, "peer"), delivery };
  }

  private subagent(): void {
    const ref = `agent-${this.agents++}`;
    const background = this.rng.chance(this.p.backgroundShare);
    const calls = this.scaled(this.rng.quantile(this.p.subagentToolCalls));
    const body: WindowStep[] = this.batches(calls, 1_200).map((batch) => ({ kind: "tools", calls: batch }));
    const task = this.task();
    this.steps.push({
      kind: "subagent",
      ref,
      agentType: this.rng.pick(AGENT_TYPES),
      description: task.slice(0, 40),
      task,
      background,
      body,
      report: this.text(600, "report"),
    });
    if (background) this.pending.push(ref);
  }

  private scaled(count: number): number {
    return Math.max(1, Math.round(count * this.p.toolScale));
  }

  /** Splits calls into batches: a run of 2–3 parallel Reads 30% of the time, otherwise one call. */
  private batches(calls: number, chars: number): ToolSpec[][] {
    const out: ToolSpec[][] = [];
    for (let left = calls; left > 0;) {
      const size = left > 1 && this.rng.chance(0.3) ? Math.min(left, this.rng.int(2, 3)) : 1;
      out.push(
        size > 1
          ? Array.from({ length: size }, () => ({ tool: "Read" as const, path: this.path(), chars }))
          : [this.call(chars)],
      );
      left -= size;
    }
    return out;
  }

  private call(chars: number): ToolSpec {
    const u = this.rng.next();
    if (u < 0.45) return { tool: "Read", path: this.path(), chars };
    if (u < 0.8) {
      const [command, description] = this.rng.pick(COMMANDS);
      const exitCode = this.rng.chance(this.p.bashFailureShare) ? 1 : 0;
      return { tool: "Bash", command, description, chars, exitCode };
    }
    if (u < 0.95) return { tool: "Edit", path: this.path(), oldString: "return a;", newString: "return a ?? b;" };
    return { tool: "Write", path: this.path(), chars: Math.min(chars, 4_000) };
  }

  private path(): string {
    return `${this.rng.pick(FOLDERS)}/${this.rng.pick(FILES)}`;
  }

  private task(): string {
    return this.rng.pick(TASKS).replace("{path}", this.path());
  }

  private text(chars: number, key: string): string {
    return filler(`${key}:${this.rng.hex(8)}`, chars);
  }
}

const WORDS = [
  "const",
  "return",
  "config",
  "value",
  "result",
  "await",
  "request",
  "handler",
  "error",
  "user",
  "token",
  "path",
  "cache",
  "retry",
  "export",
  "function",
  "options",
  "session",
  "parse",
  "update",
];

/** Deterministic synthetic text of about `chars` characters, from the key alone. */
export function filler(key: string, chars: number): string {
  const rng = new Rng(hashString(key));
  const lines: string[] = [];
  let size = 0;
  while (size < chars) {
    const words = Array.from({ length: rng.int(4, 11) }, () => rng.pick(WORDS));
    const line = `${words.join(" ")};`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n").slice(0, Math.max(1, chars));
}

/** Shape statistics of a script, measured on the data (no processes). */
export interface ShapeStats {
  humanPrompts: number;
  nonHumanSubmits: number;
  subagentWindows: number;
  rewinds: number;
  compactions: number;
  /** Tool calls between consecutive human prompts, subagents included (R6's per-turn measure). */
  toolCallsPerHumanTurn: number[];
}

export function shapeStats(script: SessionScript): ShapeStats {
  const stats: ShapeStats = {
    humanPrompts: 0,
    nonHumanSubmits: 0,
    subagentWindows: 0,
    rewinds: 0,
    compactions: 0,
    toolCallsPerHumanTurn: [],
  };
  const count = (steps: readonly Step[]): number =>
    steps.reduce(
      (n, step) => n + (step.kind === "tools" ? step.calls.length : step.kind === "subagent" ? count(step.body) : 0),
      0,
    );
  for (const step of script.steps) {
    if (step.kind === "prompt" || step.kind === "rewind" || step.kind === "queued-prompt") {
      stats.humanPrompts++;
      stats.toolCallsPerHumanTurn.push(0);
    }
    if (step.kind === "rewind") stats.rewinds++;
    if (step.kind === "notify" || step.kind === "peer") stats.nonHumanSubmits++;
    if (step.kind === "subagent") stats.subagentWindows++;
    if (step.kind === "compact") stats.compactions++;
    const last = stats.toolCallsPerHumanTurn.length - 1;
    if (last >= 0) stats.toolCallsPerHumanTurn[last]! += count([step]);
  }
  return stats;
}

/** Turns a tool spec into a call with a fresh id; the text is the spec's, else `filler`'s, keyed by the id. */
export function toolCall(world: SimWorld, spec: ToolSpec): ToolCall {
  const id = toolUseId(world.ids);
  if (spec.violates?.length) world.violations.set(id, spec.violates);
  const at = (path: string) => `${world.projectDir}/${path}`;
  switch (spec.tool) {
    case "Read":
      return readCall(id, at(spec.path), spec.text ?? filler(id, spec.chars));
    case "Edit":
      return editCall(id, at(spec.path), spec.oldString, spec.newString);
    case "Write":
      return writeCall(id, at(spec.path), filler(id, spec.chars));
    case "Bash":
      return bashCall(id, spec.command, spec.description, spec.text ?? filler(id, spec.chars), spec.exitCode);
  }
}

async function runWindowSteps(world: SimWorld, window: Window, steps: readonly WindowStep[]): Promise<void> {
  for (const step of steps) {
    if (step.kind === "tools") await window.tools(step.calls.map((spec) => toolCall(world, spec)));
    else await window.assistant(step.text);
  }
}

function noteOf(step: Said): PromptNote {
  return { cue: step.cue, sets: step.sets };
}

export interface PlayResult {
  session: SimSession;
  /** Steps skipped because a hook blocked the prompt they answer, or stopped the Agent call they belong to. */
  skipped: number;
}

/** Replays a script through the simulator. Hooks can change what happens (a blocked prompt skips its turn). */
export async function play(script: SessionScript, world: SimWorld): Promise<PlayResult> {
  const session = world.newSession();
  const runs = new Map<string, { run: AgentRun; body: WindowStep[] }>();
  let answering = true;
  let skipped = 0;
  for (const step of script.steps) {
    const turnStep = step.kind === "tools" || step.kind === "assistant" || step.kind === "stop";
    if ((turnStep || step.kind === "subagent" || step.kind === "queued-prompt") && !answering) {
      skipped++;
      continue;
    }
    switch (step.kind) {
      case "start":
        await session.start();
        break;
      case "prompt":
        answering = await session.prompt(step.text, step.source, noteOf(step));
        break;
      case "rewind":
        answering = await session.rewind(step.index, step.text, noteOf(step));
        break;
      case "queued-prompt":
        await session.queued("human", step.text, noteOf(step));
        break;
      case "tools":
      case "assistant":
        await runWindowSteps(world, session.main, [step]);
        break;
      case "subagent": {
        const run = await session.subagent(step, (window) => runWindowSteps(world, window, step.body));
        if (run && step.background) runs.set(step.ref, { run, body: step.body });
        break;
      }
      case "notify": {
        const entry = runs.get(step.ref);
        if (!entry) {
          skipped++;
          break;
        }
        const done = await session.completeBackground(entry.run, (window) => runWindowSteps(world, window, entry.body));
        if (step.delivery === "mid-turn") await session.queued("task-notification", notificationText(done));
        else answering = await session.taskNotification(done);
        break;
      }
      case "peer":
        if (step.delivery === "mid-turn") await session.queued("peer", peerText(step.from, step.text));
        else answering = await session.peerMessage(step.from, step.text);
        break;
      case "stop":
        await session.stop();
        break;
      case "compact":
        await session.compact(step.trigger, step.summary);
        break;
      case "end":
        await session.end();
        break;
      case "resume":
        await session.resume(step.gapSeconds);
        break;
      case "repo":
        world.changeRepo(step.files, step.sets);
        break;
    }
  }
  return { session, skipped };
}

/**
 * The gate's session (P0.0a target 5): R6's shape with every feature switched on, scaled down for CI.
 * The seed rule: among seeds 1–3,000 whose script has every feature, the one nearest R6's ratios, scored
 * |non-human ÷ human − 1.7| / 1.7 + |subagent windows − 8.2| / 8.2 (ties: fewer tool calls). That is 1937:
 * 10 non-human submits for 6 human prompts, 8 subagent windows, 55 tool calls.
 */
export const CANONICAL_SEED = 1937;
export const CANONICAL_SHAPE: Partial<ShapeParams> = {
  humanPrompts: [
    [0, 6],
    [1, 6],
  ],
  rewindShare: 1,
  resumeShare: 1,
  toolScale: 0.15,
  growthScale: 0.1,
  compactAtTokens: 30_000,
  midTurnShare: 0.5,
  peersPerTurn: 0.4,
  queuedPromptShare: 0.3,
  midTurnPromptShare: 0.2,
  bashFailureShare: 0.25,
};

export function canonicalSession(): SessionScript {
  return generateSession(CANONICAL_SEED, CANONICAL_SHAPE);
}

/**
 * The latency soak: `turns` human prompts in one session, one tool call per turn, and no subagents, peers,
 * rewinds or resumes, so UserPromptSubmit, PostToolUse and Stop each fire about once per turn. A5 §2 needs
 * ≥ 1,000 samples per point for a p99. Context grows at a tenth of R6's rate, so it compacts every few hundred
 * turns.
 */
export function soakSession(turns = 1_000, seed = 1): SessionScript {
  return generateSession(seed, {
    humanPrompts: [
      [0, turns],
      [1, turns],
    ],
    mainToolCalls: [
      [0, 1],
      [1, 1],
    ],
    subagentTurnShare: 0,
    peersPerTurn: 0,
    rewindShare: 0,
    resumeShare: 0,
    queuedPromptShare: 0,
    midTurnPromptShare: 0,
    growthScale: 0.1,
  });
}
