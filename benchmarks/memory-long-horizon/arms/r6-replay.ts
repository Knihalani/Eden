#!/usr/bin/env bun
/**
 * Replays this machine's real Claude Code sessions through a plugin's hooks: the gate ROADMAP P0.2 names
 * ("replaying R6's transcripts gives packet rate ≤ 30% and bullet volume ≤ 20% of today") and EXECUTION X8's
 * stage 0. It prints counts only, never text.
 *
 *   bun benchmarks/memory-long-horizon/arms/r6-replay.ts [--plugin DIR] [--sessions FILE] [--projects DIR]
 *       [--limit N]
 *
 * - **Sessions**: by default the ones R-7 snapshotted on 2026-09-29 (`~/.eden/migrate/session-map.json`), the corpus
 *   R6 measured, read from `~/.claude/projects` or a copy of it (`--projects`, laid out the same way, so two runs
 *   compare on the same files even after Claude Code sweeps old transcripts). A session whose transcript is gone is
 *   counted as missing. Sessions play in the order they started, in one shared Eden home, as the installed hook met
 *   them.
 * - **Events**: SessionStart(startup) when a session opens; a Stop with the last assistant text before each
 *   submit that follows assistant work; a UserPromptSubmit for every submit, with the transcript as it stood
 *   before that submit (the prompt arrives in the payload, R0 F8). Tool events are not replayed: a Submit or Stop
 *   reads the tool results from the transcript.
 * - **Submits** are classed by the transcript, never by the plugin: `human` as R6 §1.2 defines a human prompt
 *   (typed, queued, skill invocations, not meta, not a local command or an interrupt), and the non-human
 *   `task-notification` and `peer` lines (`origin.kind`). A skill invocation is submitted as `/name args`.
 * - **Measures**: packets, bullets and bytes per class; `packet_rate` = packets on human prompts ÷ human prompts
 *   (A5 §2); `bullet_volume` = bullets over every packet, SessionStart included; packets on chatter prompts.
 * - **Privacy**: the run directory holds transcript copies and a store built from them; it is removed when the
 *   replay ends, whatever happens.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { latency, rate, type Latency, type Rate } from "../harness/metrics";
import {
  sessionStartPayload,
  stopPayload,
  userPromptSubmitPayload,
  type EventContext,
  type HookPayload,
  type PermissionMode,
} from "../harness/payloads";
import { projectSlug } from "../harness/rng";
import { HookRunner, hookEnv, loadPlugin, type Invocation } from "../harness/runner";
import { bulletsOf } from "../harness/statements";
import { EDEN_PLUGIN } from "./kit";

export const SUBMIT_CLASSES = ["human", "task-notification", "peer"] as const;
export type SubmitClass = (typeof SUBMIT_CLASSES)[number];

/** R-7's snapshot of every session on this machine on 2026-09-29: the sessions R6 measured. */
export const R7_SESSION_MAP = join(homedir(), ".eden", "migrate", "session-map.json");

/** A7 §2's `ack` and `continuation` words: prompts that are chatter on their own (R6: "continue"-type prompts). */
const CHATTER = new Set([
  "ok",
  "okay",
  "thanks",
  "thank you",
  "cool",
  "nice",
  "great",
  "got it",
  "sounds good",
  "continue",
  "keep going",
  "next",
  "go on",
  "yes",
  "do it",
  "go ahead",
  "proceed",
]);

type Line = Record<string, unknown>;

/** One step of a session's replay. `upTo` is how many transcript lines exist when the event fires. */
export type Step =
  | { kind: "start"; upTo: number }
  | { kind: "stop"; upTo: number; lastAssistantMessage: string }
  | { kind: "submit"; upTo: number; submit: SubmitClass; prompt: string; promptId?: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => {
      return !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

function isToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((block) => block && typeof block === "object" && block.type === "tool_result")
  );
}

function tag(text: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
}

/** What a submit sends as the prompt: the text, or `/name args` for a skill invocation. */
export function promptOf(text: string): string {
  if (!text.trimStart().startsWith("<command-message>")) return text;
  const name = tag(text, "command-name") ?? `/${tag(text, "command-message") ?? ""}`;
  const args = tag(text, "command-args");
  return args ? `${name} ${args}` : name;
}

/** The class of a transcript line that is a submit, or undefined for any other line (R6 §1.2). */
export function submitClass(line: Line): SubmitClass | undefined {
  if (line.type !== "user" || line.isSidechain === true) return undefined;
  const message = (line.message ?? {}) as { content?: unknown };
  if (isToolResult(message.content)) return undefined;
  const kind = (line.origin as { kind?: unknown } | undefined)?.kind;
  if (kind === "task-notification" || kind === "peer") return kind;
  if (line.isMeta === true || line.isCompactSummary === true) return undefined;
  const text = textOf(message.content).trimStart();
  if (!text || text.startsWith("[Request interrupted")) return undefined;
  if (/^<(?:command-name|local-command-)/.test(text)) return undefined;
  return "human";
}

/** The replay plan of one transcript: its events in order (see the header). */
export function planSession(lines: readonly Line[]): Step[] {
  const steps: Step[] = [{ kind: "start", upTo: 0 }];
  let lastAssistant = "";
  lines.forEach((line, at) => {
    if (line.type === "assistant" && line.isSidechain !== true) {
      const text = textOf((line.message as { content?: unknown } | undefined)?.content).trim();
      if (text) lastAssistant = text;
      return;
    }
    const submit = submitClass(line);
    if (!submit) return;
    if (lastAssistant) steps.push({ kind: "stop", upTo: at, lastAssistantMessage: lastAssistant });
    lastAssistant = "";
    const prompt = promptOf(textOf((line.message as { content?: unknown }).content));
    const promptId = typeof line.promptId === "string" ? line.promptId : undefined;
    steps.push({ kind: "submit", upTo: at, submit, prompt, promptId });
  });
  return steps;
}

export function isChatter(prompt: string): boolean {
  return CHATTER.has(
    prompt
      .toLowerCase()
      .replace(/[^a-z ]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

interface Tally {
  submits: number;
  packets: number;
  bullets: number;
  bytes: number;
}

export interface R6Replay {
  plugin: string;
  /** `corpus` is the SHA-256 of every replayed line, so two runs can show they read the same transcripts. */
  sessions: { listed: number; replayed: number; missing: number; corpus: string };
  bySubmit: Record<SubmitClass, Tally>;
  sessionStart: Tally;
  /** Packets on human prompts ÷ human prompts (A5 §2). */
  packet_rate: Rate;
  /** Bullets over every packet, SessionStart included. */
  bullet_volume: number;
  /** Packets on human prompts that are chatter on their own (A7 §2's ack and continuation words). */
  chatter: Rate;
  failOpen: { nonZeroExit: number; withStderr: number; timedOut: number };
  msUserPromptSubmit: Latency;
  seconds: number;
}

function emptyTally(): Tally {
  return { submits: 0, packets: 0, bullets: 0, bytes: 0 };
}

/** A transcript's parsed lines and their text as written; a torn or invalid line is skipped. */
function readTranscript(path: string): { lines: Line[]; raw: string[] } {
  const lines: Line[] = [];
  const raw: string[] = [];
  for (const text of readFileSync(path, "utf8").split("\n")) {
    try {
      const line: unknown = JSON.parse(text);
      if (!line || typeof line !== "object") continue;
      lines.push(line as Line);
      raw.push(text);
    } catch {}
  }
  return { lines, raw };
}

/** The transcript of each listed session still under `projects`, by its first timestamp. */
function findTranscripts(ids: readonly string[], projects: string): { id: string; lines: Line[]; raw: string[] }[] {
  const dirs = existsSync(projects) ? readdirSync(projects).map((name) => join(projects, name)) : [];
  return ids
    .flatMap((id) => {
      const path = dirs.map((dir) => join(dir, `${id}.jsonl`)).find((candidate) => existsSync(candidate));
      return path ? [{ id, ...readTranscript(path) }] : [];
    })
    .sort((a, b) => String(a.lines[0]?.timestamp ?? "").localeCompare(String(b.lines[0]?.timestamp ?? "")));
}

function sessionIds(file: string): string[] {
  const map = JSON.parse(readFileSync(file, "utf8")) as { sessions?: Record<string, unknown> };
  return Object.keys(map.sessions ?? {});
}

function contextOf(invocations: readonly Invocation[]): string | undefined {
  return invocations.map((call) => call.outcome.additionalContext).find((context) => context !== undefined);
}

/** `~/.claude/projects`: where Claude Code keeps every session's transcript. */
export const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

export async function replayR6(options: {
  pluginDir: string;
  sessions: string[];
  projects: string;
  runDir: string;
}): Promise<R6Replay> {
  const started = performance.now();
  const plugin = loadPlugin(options.pluginDir);
  const home = join(options.runDir, "home");
  const projectDir = join(options.runDir, "project");
  mkdirSync(projectDir, { recursive: true });
  const runner = new HookRunner({ plugin, projectDir, env: hookEnv({ home, projectDir, plugin }) });
  const transcripts = findTranscripts(options.sessions, options.projects);
  const bySubmit = Object.fromEntries(SUBMIT_CLASSES.map((name) => [name, emptyTally()])) as Record<SubmitClass, Tally>;
  const sessionStart = emptyTally();
  const failOpen = { nonZeroExit: 0, withStderr: 0, timedOut: 0 };
  const submitMs: number[] = [];
  let chatter = { k: 0, n: 0 };
  for (const { id, lines, raw } of transcripts) {
    const cwd = String(lines.find((line) => typeof line.cwd === "string")?.cwd ?? projectDir);
    const transcriptPath = join(home, ".claude", "projects", projectSlug(cwd), `${id}.jsonl`);
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
    writeFileSync(transcriptPath, "");
    let written = 0;
    for (const step of planSession(lines)) {
      if (step.upTo > written) appendFileSync(transcriptPath, `${raw.slice(written, step.upTo).join("\n")}\n`);
      written = Math.max(written, step.upTo);
      const mode = lines[step.upTo]?.permissionMode;
      const ctx: EventContext = {
        sessionId: id,
        transcriptPath,
        cwd,
        permissionMode: (typeof mode === "string" ? mode : "default") as PermissionMode,
        promptId: step.kind === "submit" ? step.promptId : undefined,
      };
      const payload: HookPayload =
        step.kind === "start"
          ? sessionStartPayload(ctx, "startup")
          : step.kind === "stop"
            ? stopPayload(ctx, { lastAssistantMessage: step.lastAssistantMessage })
            : userPromptSubmitPayload(ctx, step.prompt);
      const invocations = await runner.dispatch(payload);
      for (const call of invocations) {
        if (call.exitCode !== 0) failOpen.nonZeroExit++;
        if (call.stderr.trim()) failOpen.withStderr++;
        if (call.timedOut) failOpen.timedOut++;
        if (step.kind === "submit") submitMs.push(call.endedAt - call.startedAt);
      }
      if (step.kind === "stop") continue;
      const tally = step.kind === "start" ? sessionStart : bySubmit[step.submit];
      const packet = contextOf(invocations);
      if (step.kind === "submit") tally.submits++;
      if (step.kind === "submit" && step.submit === "human" && isChatter(step.prompt)) {
        chatter = { k: chatter.k + (packet ? 1 : 0), n: chatter.n + 1 };
      }
      if (!packet) continue;
      tally.packets++;
      tally.bullets += bulletsOf(packet).length;
      tally.bytes += Buffer.byteLength(packet, "utf8");
    }
  }
  const human = bySubmit.human;
  return {
    plugin: options.pluginDir,
    sessions: {
      listed: options.sessions.length,
      replayed: transcripts.length,
      missing: options.sessions.length - transcripts.length,
      corpus: createHash("sha256")
        .update(transcripts.map((transcript) => transcript.raw.join("\n")).join("\n"))
        .digest("hex"),
    },
    bySubmit,
    sessionStart,
    packet_rate: rate(human.packets, human.submits),
    bullet_volume: sessionStart.bullets + SUBMIT_CLASSES.reduce((n, name) => n + bySubmit[name].bullets, 0),
    chatter: rate(chatter.k, chatter.n),
    failOpen,
    msUserPromptSubmit: latency(submitMs),
    seconds: Math.round((performance.now() - started) / 1000),
  };
}

function argument(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: string[]): Promise<void> {
  const limit = Number(argument(args, "--limit") ?? Infinity);
  const sessions = sessionIds(argument(args, "--sessions") ?? R7_SESSION_MAP).slice(0, limit);
  const runDir = mkdtempSync(join(tmpdir(), "eden-r6-replay-"));
  try {
    const pluginDir = resolve(argument(args, "--plugin") ?? EDEN_PLUGIN);
    const projects = resolve(argument(args, "--projects") ?? CLAUDE_PROJECTS);
    console.log(JSON.stringify(await replayR6({ pluginDir, sessions, projects, runDir }), null, 2));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main(process.argv.slice(2));
