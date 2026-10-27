#!/usr/bin/env bun
/**
 * Plays a StreamBench stream (`worlds/<world>/stream.json`, assemble.py) through a plugin's real hooks, with the
 * long-horizon simulator (one process per hook, Claude Code's payloads and event order). It writes what a
 * retrieval method needs to be scored on the write path:
 *
 *   <out>/packets.jsonl   one line per delivery point: {event, hook, at, content, ms}. `event` is the stream event
 *                         id of a submit (human, trigger, notification, peer) or `<session>:start`
 *   <out>/times.json      the simulated time (epoch ms) of every stream event, for store visibility
 *   <out>/store.json      `eden memory dump --json` at the end: the write path's rows, each with its write time `t`
 *   <out>/summary.json    counts, fail-open, hook latency by point
 *
 *   bun benchmarks/memory-stream/replay.ts --world code [--plugin DIR] [--out DIR] [--limit N] [--env K=V]
 *
 * Consecutive `resume` sessions continue the same simulated session (end, then `--resume` after the gap). A
 * notification's background subagent is launched in the turn before it. A trigger is a UserPromptSubmit the host
 * sends with no human typing (scheduled tasks arrive this way).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { plainCue } from "../memory-long-horizon/harness/cues";
import { latencyByPoint } from "../memory-long-horizon/harness/metrics";
import { idleSleepOf, loadPlugin } from "../memory-long-horizon/harness/runner";
import { SimWorld, type AgentRun, type SimSession } from "../memory-long-horizon/harness/session";
import { toolCall, type ToolSpec } from "../memory-long-horizon/harness/shape";

interface StreamEvent {
  id: string;
  t: string;
  k?: number;
  text?: string;
  name?: string;
  input?: Record<string, string>;
  output?: string;
  task?: string;
  report?: string;
  from?: string;
  summary?: string;
  labels: { class: string };
}
interface StreamSession {
  id: string;
  ts: string;
  kind: "startup" | "resume";
  events: StreamEvent[];
}
interface Stream {
  world: string;
  files: string[];
  items: { id: string; text: string }[];
  sessions: StreamSession[];
}

const argv = process.argv.slice(2);
const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const world = arg("--world") ?? "code";
const here = import.meta.dir;
const stream: Stream = JSON.parse(readFileSync(join(here, "worlds", world, "stream.json"), "utf8"));
const pluginDir = resolve(arg("--plugin") ?? join(here, "../../plugins/eden-memory"));
const out = resolve(arg("--out") ?? join(here, "runs", world));
const limit = Number(arg("--limit") ?? Infinity);
const extraEnv = Object.fromEntries(
  argv.flatMap((a, i) => (argv[i - 1] === "--env" ? [a.split("=") as [string, string]] : [])),
);
mkdirSync(join(out, "run"), { recursive: true });

const stamp = (ts: string) => Date.parse(`${ts}:00.000Z`);

function projectFiles(): Record<string, string> {
  const byId = new Map(stream.items.map((x) => [x.id, x.text]));
  if (world === "code") {
    const rules = stream.files.map((id) => `- ${byId.get(id)}`).join("\n");
    return {
      "CLAUDE.md": `# acme-platform\n\nAcme's B2B invoicing platform. Monorepo: apps/web, apps/api, services/worker, packages/cli, infra.\n\n## Rules\n${rules}\n`,
      "README.md": "# acme-platform\n\nSee CLAUDE.md for conventions.\n",
      "package.json": '{ "name": "acme-platform", "private": true }\n',
      "apps/web/package.json": '{ "name": "@acme/web", "private": true }\n',
      "apps/api/package.json": '{ "name": "@acme/api", "private": true }\n',
      "services/worker/package.json": '{ "name": "@acme/worker", "private": true }\n',
      "packages/cli/package.json": '{ "name": "@acme/cli", "private": true }\n',
      "infra/README.md": "# infra\n",
    };
  }
  return {
    "CLAUDE.md": "# Assistant workspace\n\nRiya's personal and work assistant. Tools are in ./bin.\n",
    "notes/README.md": "# notes\n",
  };
}

function toolSpec(e: StreamEvent): ToolSpec {
  const input = e.input ?? {};
  const output = e.output ?? "";
  const path = (input.path ?? "notes/untitled.md").replace(/^\/+/, "");
  switch (e.name) {
    case "Read":
      return { tool: "Read", path, chars: output.length, text: output };
    case "Edit":
      return { tool: "Edit", path, oldString: input.old ?? "", newString: input.new ?? "" };
    case "Write":
      return { tool: "Write", path, chars: (input.content ?? "").length, text: input.content ?? "" };
    default:
      return {
        tool: "Bash",
        command: input.command ?? "true",
        description: "",
        chars: output.length,
        exitCode: 0,
        text: output || "(no output)",
      };
  }
}

const sim = new SimWorld({
  runDir: join(out, "run"),
  plugin: loadPlugin(pluginDir),
  clockEnv: true,
  idleSleep: idleSleepOf(pluginDir),
  seed: 1,
  flush: "lagging",
  env: extraEnv,
  projectFiles: projectFiles(),
  clock: { ms: stamp(stream.sessions[0]!.ts) },
});

const packets: Record<string, unknown>[] = [];
const times: Record<string, number> = {};
let seen = 0;
let current: StreamEvent | undefined;
function collect(event: string): void {
  for (const d of sim.deliveries.slice(seen)) {
    const record = sim.log[d.seq];
    const ms = record?.invocations.reduce((n, inv) => Math.max(n, inv.endedAt - inv.startedAt), 0);
    packets.push({ event, hook: d.event, window: d.window, at: sim.timeMs, content: d.content, ms });
  }
  seen = sim.deliveries.length;
}

async function playTurn(session: SimSession, events: StreamEvent[], runs: Map<string, AgentRun>): Promise<void> {
  // events: one submit (or none, at session start) and what follows it until the next submit
  let batch: ToolSpec[] = [];
  const flush = async () => {
    if (batch.length) await session.main.tools(batch.map((spec) => toolCall(sim, spec)));
    batch = [];
  };
  for (const e of events) {
    times[e.id] = sim.timeMs;
    current = e;
    if (e.t === "tool") {
      batch.push(toolSpec(e));
      continue;
    }
    await flush();
    if (e.t === "assistant") await session.main.assistant(e.text ?? "");
    else if (e.t === "human" || e.t === "trigger") {
      await session.prompt(e.text ?? "", "typed", { cue: plainCue("") });
      collect(e.id);
    } else if (e.t === "peer") {
      await session.peerMessage(e.from ?? "agent", e.text ?? "");
      collect(e.id);
    } else if (e.t === "notification") {
      const run = runs.get(e.id);
      if (run) {
        const report = e.report ?? "";
        const done = await session.completeBackground(run, (w) => w.assistant(report));
        await session.taskNotification(done);
        collect(e.id);
      }
    } else if (e.t === "compact") {
      await session.compact("auto", e.summary ?? "");
      collect(`${e.id}:compact`);
    } else if (e.t === "launch") {
      const n = e as unknown as { notification: StreamEvent };
      const run = await session.subagent(
        {
          agentType: "general-purpose",
          description: (n.notification.task ?? "background task").slice(0, 60),
          task: n.notification.task ?? "background task",
          background: true,
          report: n.notification.report ?? "",
        },
        async () => {},
      );
      if (run) runs.set(n.notification.id, run);
      collect(`${e.id}:launch`);
    }
  }
  await flush();
}

/** Splits a session's events into turns (each starts at a submit or compaction) and adds subagent launches. */
function turnsOf(events: StreamEvent[]): StreamEvent[][] {
  const turns: StreamEvent[][] = [[]];
  for (const e of events) {
    if (["human", "trigger", "peer", "notification", "compact"].includes(e.t)) turns.push([]);
    turns[turns.length - 1]!.push(e);
  }
  // A notification's background task starts in the latest earlier human or trigger turn.
  for (let i = 0; i < turns.length; i++) {
    const head = turns[i]![0];
    if (head?.t !== "notification") continue;
    for (let j = i - 1; j >= 0; j--) {
      const h = turns[j]![0];
      if (h && (h.t === "human" || h.t === "trigger")) {
        const launch = { id: `${head.id}:launch`, t: "launch", notification: head, labels: { class: "launch" } };
        const at = turns[j]!.findIndex((e) => e.t === "assistant");
        turns[j]!.splice(at < 0 ? turns[j]!.length : at, 0, launch as unknown as StreamEvent);
        break;
      }
    }
  }
  return turns.filter((t) => t.length);
}

const started = Date.now();
let session: SimSession | undefined;
let runs = new Map<string, AgentRun>();
let played = 0;
for (const s of stream.sessions.slice(0, limit)) {
  const at = stamp(s.ts);
  if (s.kind === "resume" && session) {
    await session.end("other");
    const gap = Math.max(60, Math.round((at - sim.timeMs) / 1000));
    await session.resume(gap);
    collect(`${s.id}:start`);
  } else {
    if (session) await session.end("other");
    if (at > sim.timeMs) sim.advance(at - sim.timeMs);
    session = sim.newSession();
    runs = new Map();
    await session.start("startup");
    collect(`${s.id}:start`);
  }
  for (const turn of turnsOf(s.events)) {
    await playTurn(session, turn, runs);
    if (turn[0] && ["human", "trigger", "peer", "notification"].includes(turn[0].t)) await session.stop();
  }
  played++;
  if (played % 10 === 0) console.error(`${played} sessions, ${Math.round((Date.now() - started) / 1000)} s`);
}
if (session) await session.end("other");
await sim.settle();
void current;

const dump = spawnSync("bun", [join(here, "../../packages/cli/src/cli.ts"), "memory", "dump", "--json"], {
  cwd: sim.projectDir,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: sim.home,
    EDEN_HOME: join(sim.home, ".eden"),
    EDEN_MEMORY_DIR: join(sim.home, ".eden", "memory"),
    EDEN_NOW: String(sim.timeMs),
  },
  encoding: "utf8",
  maxBuffer: 1 << 30,
});
writeFileSync(join(out, "store.json"), dump.stdout || '{"rows": [], "ledger": []}');
writeFileSync(join(out, "packets.jsonl"), packets.map((p) => JSON.stringify(p)).join("\n") + "\n");
writeFileSync(join(out, "times.json"), JSON.stringify(times));
const invocations = sim.log.flatMap((r) => r.invocations);
const summary = {
  world,
  plugin: pluginDir,
  sessions: played,
  events: sim.log.length,
  invocations: invocations.length,
  nonZeroExit: invocations.filter((i) => i.exitCode !== 0).length,
  timedOut: invocations.filter((i) => i.timedOut).length,
  packets: packets.length,
  storeRows: (JSON.parse(dump.stdout || '{"rows": []}') as { rows: unknown[] }).rows.length,
  msByPoint: latencyByPoint(sim),
  wallSeconds: Math.round((Date.now() - started) / 1000),
};
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
