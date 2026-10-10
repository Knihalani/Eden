/**
 * The arm framework (A5 §4). An arm plays a script through a plugin's hooks in the simulator, or drives a product
 * entry point, and returns named checks. A failing check names the A5 assertion, or a control the assertion needs,
 * that did not hold. `arms.json` records, per arm and flag state, which checks fail on today's plugin, and the gate
 * (gate.ts) holds every run to that record.
 *
 * Flag states (X7). `on` runs with no flag file. `off` and `shadow` write `~/.eden/flags.json` with every
 * delivery-point flag set to that value before the first hook, and judge the run by the generic checks of
 * `flagChecks` instead of the arm's own:
 * - `off` is identity: exit 0, nothing printed at a delivery point, no context or decision anywhere, no ledger;
 * - `shadow` prints nothing at a delivery point but writes the shadow ledger and wide events, and no live ledger.
 *
 * Every arm world hands hooks the simulated clock as `EDEN_NOW` (session.ts `clockEnv`), and the product CLI the
 * same environment as the hooks, so a product that honours it sees the days a script skips.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { plainCue, type Cue } from "../harness/cues";
import {
  computeMetrics,
  judgeDeliveries,
  listFiles,
  type Judged,
  type JudgedBullet,
  type Metrics,
} from "../harness/metrics";
import { itemId, type Effect } from "../harness/oracle";
import type { HookEvent } from "../harness/payloads";
import { hookEnv, idleSleepOf, loadPlugin } from "../harness/runner";
import {
  simClock,
  SimWorld,
  type AgentRun,
  type PromptNote,
  type SessionPlace,
  type SimClock,
  type SimSession,
  type SubagentSpec,
  type WorldOptions,
} from "../harness/session";
import { filler, toolCall, type ToolSpec } from "../harness/shape";
import type { WorldSpec } from "../harness/world";

export type FlagState = "on" | "off" | "shadow";

/** A simulated day: the gap between a script's sessions. */
export const DAY_MS = 86_400_000;

/** A compaction summary that keeps none of the conversation's facts: after it, the window no longer states them. */
export const BLANK_SUMMARY = "The user and the agent tidied the logging setup. Nothing else was decided.";
export type Scale = "ci" | "full";

/** The delivery-point flags of X7. `EDEN_MEMORY` and the non-delivery flags (`sleep.llm`, `log.text`) are not here. */
export const DELIVERY_FLAGS = [
  "deliver.submit",
  "deliver.session_start",
  "deliver.subagent",
  "deliver.batch",
  "deliver.failure",
  "guard.context",
  "guard.ask",
] as const;

/** The events of those points: where an `off` or `shadow` plugin must print nothing. */
const DELIVERY_EVENTS = new Set<HookEvent>([
  "UserPromptSubmit",
  "SessionStart",
  "SubagentStart",
  "PostToolBatch",
  "PostToolUseFailure",
  "PreToolUse",
]);

const REPO_ROOT = resolve(import.meta.dir, "../../..");
/** Today's plugin and the product CLI, from this tree. */
export const EDEN_PLUGIN = join(REPO_ROOT, "plugins", "eden-memory");
export const EDEN_CLI = ["bun", join(REPO_ROOT, "packages", "cli", "src", "cli.ts")];

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

export function check(id: string, ok: boolean, detail: string): Check {
  return { id, ok, detail };
}

export interface ArmOptions {
  pluginDir: string;
  /** How to run the product CLI: the argv prefix before the subcommand. */
  cli: string[];
  scale: Scale;
  flags: FlagState;
  /** Extra environment for every hook and CLI process (a reference plugin's answer table). */
  env?: Record<string, string>;
}

export interface Arm {
  id: string;
  /** False for an arm with no delivery point (writers, scope rows, extraction, migrate, fail-open): no flag runs. */
  flagged: boolean;
  run(run: ArmRun): Promise<Check[]>;
}

export interface ArmResult {
  arm: string;
  flags: FlagState;
  checks: Check[];
  /** The ids of the checks that failed, sorted. */
  failed: string[];
  ms: number;
}

/** What a world of an arm brings besides its spec. */
export interface WorldSetup extends Pick<WorldOptions, "permissionMode" | "askAnswer" | "instructions"> {
  /** The repo's directory under the run directory; worlds of one arm share a home (session.ts)… */
  projectName?: string;
  /** …unless they name another: worlds with the same `home` share it, and see no other home's store. */
  home?: string;
}

/** One run of one arm: its worlds, its product CLI calls, and the flag file they all see. */
export class ArmRun {
  readonly worlds: SimWorld[] = [];
  private seed = 1;
  /** One clock per home: the worlds that share a store see one time (a product's `EDEN_NOW` never goes back). */
  private readonly clocks = new Map<string, SimClock>();

  constructor(
    readonly options: ArmOptions,
    readonly dir: string,
  ) {}

  /** A world for this run. With flags `off` or `shadow`, the flag file is written before any hook runs. */
  world(spec: WorldSpec, setup: WorldSetup = {}): SimWorld {
    const { home, ...options } = setup;
    const runDir = home === undefined ? this.dir : join(this.dir, `home-${home}`);
    mkdirSync(runDir, { recursive: true });
    const clock = this.clocks.get(runDir) ?? simClock();
    this.clocks.set(runDir, clock);
    const world = new SimWorld({
      runDir,
      clock,
      plugin: loadPlugin(this.options.pluginDir),
      seed: this.seed++,
      clockEnv: true,
      idleSleep: idleSleepOf(this.options.pluginDir),
      env: this.options.env,
      projectFiles: spec.projectFiles,
      subjects: spec.subjects,
      initialTruth: spec.initialTruth,
      ...options,
    });
    if (this.options.flags !== "on") writeFlags(world.home, this.options.flags);
    this.worlds.push(world);
    return world;
  }

  /**
   * Runs the product CLI the way a user or a scheduler would: in the repo (or `cwd`), with the hooks' environment
   * plus `env`, and `input` on stdin.
   */
  cli(world: SimWorld, args: string[], options: CliOptions = {}): CliResult {
    const paths = {
      home: world.home,
      projectDir: world.projectDir,
      plugin: world.options.plugin,
      extra: this.options.env,
    };
    const env = { ...hookEnv(paths), EDEN_NOW: String(world.timeMs), ...options.env };
    const run = Bun.spawnSync([...this.options.cli, ...args], {
      cwd: options.cwd ?? world.projectDir,
      env,
      stdin: new TextEncoder().encode(options.input ?? ""),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });
    return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  }
}

export interface CliOptions {
  input?: string;
  env?: Record<string, string>;
  cwd?: string;
}

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Parses a CLI's stdout as one JSON value; undefined when it is not JSON (an entry point that does not exist). */
export function jsonOut(result: CliResult): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

export function writeFlags(home: string, value: Exclude<FlagState, "on">): void {
  mkdirSync(join(home, ".eden"), { recursive: true });
  const flags = Object.fromEntries(DELIVERY_FLAGS.map((flag) => [flag, value]));
  writeFileSync(join(home, ".eden", "flags.json"), JSON.stringify(flags, null, 2) + "\n");
}

/** Runs one arm in a fresh directory, removed afterwards. Off and shadow runs are judged by `flagChecks`. */
export async function runArm(arm: Arm, options: ArmOptions): Promise<ArmResult> {
  if (!arm.flagged && options.flags !== "on") throw new Error(`${arm.id} has no delivery point to flag`);
  const dir = mkdtempSync(join(tmpdir(), `eden-arm-${arm.id}-`));
  const started = performance.now();
  try {
    const run = new ArmRun(options, dir);
    const own = await arm.run(run);
    const checks = options.flags === "on" ? own : flagChecks(run.worlds, options.flags);
    const failed = checks.filter((item) => !item.ok).map((item) => item.id);
    if (new Set(checks.map((item) => item.id)).size !== checks.length) throw new Error(`${arm.id}: duplicate checks`);
    return { arm: arm.id, flags: options.flags, checks, failed: failed.sort(), ms: performance.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The generic checks of an `off` or `shadow` run (see the header). */
export function flagChecks(worlds: readonly SimWorld[], state: Exclude<FlagState, "on">): Check[] {
  const records = worlds.flatMap((world) => world.log);
  const invocations = records.flatMap((record) => record.invocations);
  const atPoints = records.filter((record) => DELIVERY_EVENTS.has(record.event));
  const loud = atPoints.flatMap((record) => record.invocations).filter((call) => call.stdout || call.stderr);
  const acting = invocations.filter(
    (call) => call.outcome.additionalContext !== undefined || call.outcome.permissionDecision || call.outcome.blocked,
  );
  const files = worlds.flatMap((world) => edenFiles(world));
  const named = (name: string) => files.filter((path) => basename(path) === name);
  const nonEmpty = (paths: string[]) => paths.filter((path) => statSync(path).size > 0);
  const live = [...named("delivery.log"), ...named("delivery.json")];
  const checks = [
    check("ran", atPoints.length > 0, `${atPoints.length} events at delivery points`),
    check(
      "exit-0",
      invocations.every((call) => call.exitCode === 0),
      `exit codes ${[...new Set(invocations.map((call) => call.exitCode))].join(", ") || "none"}`,
    ),
    check("quiet", loud.length === 0, `${loud.length} delivery-point invocations printed something`),
    check("no-context", acting.length === 0, `${acting.length} invocations returned context, a decision or a block`),
  ];
  if (state === "off") {
    const ledgers = [...live, ...named("delivery.shadow.log")];
    return [...checks, check("no-ledger", ledgers.length === 0, `${ledgers.length} ledger files`)];
  }
  const shadow = nonEmpty(named("delivery.shadow.log"));
  const wide = nonEmpty(files.filter((path) => path.includes("/hook.log.d/")));
  return [
    ...checks,
    check("shadow-ledger", shadow.length > 0, `${shadow.length} non-empty delivery.shadow.log files`),
    check("wide-events", wide.length > 0, `${wide.length} non-empty files under hook.log.d/`),
    check("no-live-ledger", live.length === 0, `${live.length} live ledger files`),
  ];
}

/** Every file Eden may write for a world: its home's `.eden` and the plugin's data directory. */
export function edenFiles(world: SimWorld): string[] {
  return [
    ...listFiles(join(world.home, ".eden")),
    ...listFiles(join(world.home, ".claude", "plugins", "data", world.options.plugin.name)),
  ].filter((path) => basename(path) !== "flags.json");
}

/** What the turn of a script brings besides its prompt. */
export interface TurnOptions {
  /** The annotation; the scope defaults to the root, needs and allowed to none. */
  cue?: Partial<Cue>;
  /** The truth the prompt states (A5 §3.4). */
  sets?: Effect[];
  /** Tool batches the agent runs after the prompt, before its reply. */
  tools?: ToolSpec[][];
  /** The agent's reply, which ends the turn before Stop. */
  reply?: string;
  /** More of the agent's work after its tool batches, before the reply (subagent launches). */
  within?: (driver: Driver) => Promise<void>;
}

/** An Agent call: the subagent type and task, and optionally its packet's annotation and a background launch. */
export type SubagentCall = Pick<SubagentSpec, "agentType" | "task"> &
  Partial<Omit<SubagentSpec, "cue">> & { cue?: Partial<Cue> };

/** A human turn as it happened: its UserPromptSubmit event and, when it was not blocked, its cue record. */
export interface Turn {
  seq: number;
  cue: number;
  submitted: boolean;
}

/** Drives one session the way a scripted user would: annotated prompts, tool batches, replies, Stop. */
export class Driver {
  private constructor(
    readonly world: SimWorld,
    readonly spec: WorldSpec,
    public session: SimSession,
  ) {}

  static async start(world: SimWorld, spec: WorldSpec, place?: SessionPlace): Promise<Driver> {
    const session = world.newSession(place);
    await session.start();
    return new Driver(world, spec, session);
  }

  /** A human turn: the prompt (annotated), the agent's tool batches, its reply, and Stop. */
  turn(text: string, options: TurnOptions = {}): Promise<Turn> {
    return this.play(options, (note) => this.session.prompt(text, "typed", note));
  }

  /** The user rewinds to the human prompt at `index` (since the last compaction) and submits `text` instead. */
  rewind(index: number, text: string, options: TurnOptions = {}): Promise<Turn> {
    return this.play(options, (note) => this.session.rewind(index, text, note));
  }

  private async play(options: TurnOptions, submit: (note: PromptNote) => Promise<boolean>): Promise<Turn> {
    const seq = this.world.log.length;
    const cue = this.world.cues.length;
    const submitted = await submit({ cue: { ...plainCue(), ...options.cue }, sets: options.sets });
    if (submitted) {
      for (const batch of options.tools ?? []) await this.tools(batch);
      await options.within?.(this);
      await this.session.main.assistant(options.reply ?? filler(`reply:${seq}`, 160));
      await this.session.stop();
    }
    return { seq, cue, submitted };
  }

  /**
   * An Agent call from the main window: the subagent runs `body` (tool batches) and reports. Returns the
   * SubagentStart event's position and, when `spec.cue` annotates its packet, the cue record.
   */
  async subagent(spec: SubagentCall, body: ToolSpec[][] = []): Promise<Turn & { run: AgentRun | null }> {
    const seq = this.world.log.length;
    const cue = this.world.cues.length;
    const full = {
      background: false,
      report: filler(`report:${seq}`, 200),
      description: spec.task.slice(0, 40),
      ...spec,
      cue: spec.cue && { ...plainCue(), ...spec.cue },
    };
    const run = await this.session.subagent(full, async (window) => {
      for (const batch of body) await window.tools(batch.map((item) => toolCall(this.world, item)));
    });
    const start = this.world.log.findIndex((record, at) => at >= seq && record.event === "SubagentStart");
    return { seq: start, cue, submitted: run !== null, run };
  }

  /** The user states truth: the turn allows the items it sets, at the scope it is said in. */
  say(text: string, sets: Effect[], scope = "", options: TurnOptions = {}): Promise<Turn> {
    const allowed = sets.map((effect) => itemId(effect.key, effect.scope));
    return this.turn(text, { ...options, sets, cue: { scope, allowed, ...options.cue } });
  }

  /** The user asks something the annotation says the turn needs (or allows). */
  ask(text: string, cue: Partial<Cue>, options: TurnOptions = {}): Promise<Turn> {
    return this.turn(text, { ...options, cue });
  }

  /**
   * A background subagent finishes and its task notification arrives while the agent is idle: a non-human submit,
   * answered by a short acknowledgement and Stop. Returns the submit's event position.
   */
  async notify(run: AgentRun, body: ToolSpec[][] = []): Promise<number> {
    const done = await this.session.completeBackground(run, async (window) => {
      for (const batch of body) await window.tools(batch.map((item) => toolCall(this.world, item)));
    });
    const seq = this.world.log.length;
    if (await this.session.taskNotification(done)) {
      await this.session.main.assistant("Noted the result.");
      await this.session.stop();
    }
    return seq;
  }

  /** One batch of tool calls in the main window, outside a prompt's turn. */
  async tools(specs: ToolSpec[]): Promise<void> {
    await this.session.main.tools(specs.map((spec) => toolCall(this.world, spec)));
  }

  /** Compaction with a summary the script chooses: what the window keeps of the conversation. */
  async compact(summary: string): Promise<void> {
    await this.session.compact("auto", summary);
  }

  async end(): Promise<void> {
    await this.session.end();
  }

  /** `--resume` of this session after `gapSeconds`. */
  async resume(gapSeconds = 3_600): Promise<void> {
    await this.session.resume(gapSeconds);
  }
}

/** A Read of `path` (relative to the project) whose result is `text`. */
export function read(path: string, text: string): ToolSpec {
  return { tool: "Read", path, chars: text.length, text };
}

/** A Bash call; a non-zero exit fails it into PostToolUseFailure. */
export function bash(command: string, exitCode = 0, text = "", violates?: string[]): ToolSpec {
  return { tool: "Bash", command, description: command, chars: text.length, exitCode, text, violates };
}

/** The packets of a world, read against its oracle and the window each landed in. */
export function judged(world: SimWorld, spec: WorldSpec): Judged[] {
  return judgeDeliveries(world, spec);
}

export function metricsOf(world: SimWorld, spec: WorldSpec): Metrics {
  return computeMetrics(world, spec);
}

/** The bullets delivered by events in `[from, to)` (by event-log position), at any point. */
export function bulletsIn(packets: readonly Judged[], from: number, to = Infinity): JudgedBullet[] {
  return packets
    .filter((packet) => packet.delivery.seq >= from && packet.delivery.seq < to)
    .flatMap((packet) => packet.bullets);
}

/** The packets one event delivered. */
export function packetsAt(packets: readonly Judged[], seq: number): Judged[] {
  return packets.filter((packet) => packet.delivery.seq === seq);
}

/** Whether a bullet states `value` for `key` (at any scope unless one is given). */
export function states(bullet: JudgedBullet, key: string, value: string, scope?: string): boolean {
  return bullet.stated.some(
    (stated) =>
      stated.value === value &&
      (scope === undefined ? stated.item.startsWith(`${key}@`) : stated.item === itemId(key, scope)),
  );
}

/** Short, quotable text of some bullets, for a check's detail. */
export function quote(bullets: readonly JudgedBullet[], limit = 3): string {
  if (!bullets.length) return "none";
  const shown = bullets.slice(0, limit).map((bullet) => JSON.stringify(bullet.text.slice(0, 120)));
  return shown.join("; ") + (bullets.length > limit ? `; … ${bullets.length - limit} more` : "");
}

/** Whether the cue's needed items were in its packet or its window (A5 `need_miss`). */
export function needMet(metrics: Metrics, turn: Turn): boolean {
  return turn.submitted && metrics.cues[turn.cue]?.missed === false;
}

/** The bullets one event delivered, as the oracle reads them. */
export function bulletsAt(world: SimWorld, spec: WorldSpec, seq: number): JudgedBullet[] {
  return packetsAt(judged(world, spec), seq).flatMap((packet) => packet.bullets);
}

/**
 * A need check (A5 `need_miss`): every turn's needed items were in its packet or its window. The detail names the
 * missed cues, and quotes the packets delivered from event `from` (default: the last cue's own) up to the last cue.
 */
export function needCheck(
  name: string,
  world: SimWorld,
  spec: WorldSpec,
  turns: Turn | readonly Turn[],
  options: { from?: number; note?: string } = {},
): Check {
  const list = Array.isArray(turns) ? turns : [turns as Turn];
  const metrics = metricsOf(world, spec);
  const missed = list.filter((turn) => !needMet(metrics, turn)).map((turn) => world.cues[turn.cue]?.text ?? "?");
  const last = list.at(-1)!;
  const delivered = bulletsIn(judged(world, spec), options.from ?? last.seq, last.seq + 1);
  const status = missed.length ? `missed: ${missed.join(" | ")}` : "met";
  return check(name, missed.length === 0, `${status}; packets: ${quote(delivered)}${options.note ?? ""}`);
}

/** No bullet delivered from event `from` on states a value the oracle does not hold then (A5 `stale_rate`). */
export function noStale(world: SimWorld, spec: WorldSpec, from = 0, name = "no-stale"): Check {
  const stale = bulletsIn(judged(world, spec), from).filter((bullet) => bullet.stale);
  return check(name, stale.length === 0, `stale bullets: ${quote(stale)}`);
}

/** How many bytes the session's main transcript holds now. */
export function transcriptBytes(session: SimSession): number {
  try {
    return statSync(session.transcriptPath).size;
  } catch {
    return 0;
  }
}

/** The text of every non-empty wide-event file (`hook.log.d/`) a world wrote. */
export function wideEvents(world: SimWorld): string {
  return edenFiles(world)
    .filter((path) => path.includes("/hook.log.d/"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

/** Pasted text as Claude Code marks it when paste marking is on (R0 F30; D12): between matching id markers. */
export function pasted(text: string, id: string): string {
  return `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`;
}
