/**
 * Harness self-test plugin: answers each hook from a table, so a test knows every packet in advance.
 * SCRIPTED_ANSWERS names a JSON list of rules. The first rule whose `event` is the hook's and whose `when` occurs in
 * the raw payload (every one of them, for a list) answers with its context, permission decision and reason. With no
 * matching rule, or a rule with neither a context nor a decision, it prints nothing. By default it never writes a file.
 *
 * With SCRIPTED_REFERENCE=1 it is the A5 arms' reference plugin (arms/reference.ts), and also does what a correct
 * plugin does around its answers:
 * - flags (X7): at a point that `$HOME/.eden/flags.json` sets `off` it prints nothing; set `shadow`, it prints nothing
 *   and appends what it would have said to `$EDEN_HOME/delivery.shadow.log`;
 * - a `once` rule answers its first match only; a rule with `tag` records its firings, and a rule with `after: "t"`
 *   (or `"t×N"`) waits until tag `t` has fired (N times);
 * - SubagentStart has no task (R0 F27), so its rules also match the task that PreToolUse(Agent) recorded, the newest
 *   unconsumed one of the same agent type (A4 §5.3);
 * - every invocation appends a wide event to `$EDEN_HOME/hook.log.d/events.jsonl`: the event, the tool_use_id, the
 *   context tokens of the transcript's latest `message.usage` beside its bytes, the rule's `log` label, and
 *   `declined` for a PostToolBatch call the user declined (A6 §2.5);
 * - with SCRIPTED_EPISODES=1, every prompt is kept in `$EDEN_HOME/episodes.jsonl`, as a memory keeps its episodes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface Rule {
  event: string;
  when: string | string[];
  context?: string;
  decision?: "ask" | "allow" | "deny";
  reason?: string;
  once?: boolean;
  tag?: string;
  after?: string;
  log?: string;
}

type Payload = Record<string, unknown> & { hook_event_name: string };

const FLAG_OF: Record<string, string> = {
  UserPromptSubmit: "deliver.submit",
  SessionStart: "deliver.session_start",
  SubagentStart: "deliver.subagent",
  PostToolBatch: "deliver.batch",
  PostToolUseFailure: "deliver.failure",
  PreToolUse: "guard.context",
};

const raw = await Bun.stdin.text();
const payload = JSON.parse(raw) as Payload;
const event = payload.hook_event_name;
const rules = (await Bun.file(process.env.SCRIPTED_ANSWERS!).json()) as Rule[];
const reference = process.env.SCRIPTED_REFERENCE === "1";
const data = process.env.CLAUDE_PLUGIN_DATA ?? "";
const eden = process.env.EDEN_HOME ?? "";

const lines = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

/** The task PreToolUse(Agent) recorded for this subagent: the newest unconsumed one of its type, now consumed. */
function spawnedTask(): string {
  const spawns = lines(join(data, "spawn.log")).map((line) => JSON.parse(line) as { type: string; task: string });
  const taken = new Set(lines(join(data, "spawn.taken")).map(Number));
  const index = spawns.findLastIndex((spawn, at) => spawn.type === payload.agent_type && !taken.has(at));
  if (index < 0) return "";
  appendFileSync(join(data, "spawn.taken"), `${index}\n`);
  return spawns[index]!.task;
}

/** Rule indexes that fired, and tags with how often they fired. */
function history(): { fired: Set<number>; tags: Map<string, number> } {
  const fired = new Set<number>();
  const tags = new Map<string, number>();
  for (const line of reference ? lines(join(data, "fired.log")) : []) {
    const [index, tag] = line.split("\t");
    fired.add(Number(index));
    if (tag) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  return { fired, tags };
}

function eligible(rule: Rule, at: number, past: ReturnType<typeof history>): boolean {
  if (rule.once && past.fired.has(at)) return false;
  if (!rule.after) return true;
  const [tag, times] = rule.after.split("×");
  return (past.tags.get(tag!) ?? 0) >= Number(times ?? 1);
}

function matching(): { rule: Rule; index: number } | undefined {
  const past = history();
  const text = reference && event === "SubagentStart" ? `${raw}\n${spawnedTask()}` : raw;
  const index = rules.findIndex((rule, at) => {
    const parts = Array.isArray(rule.when) ? rule.when : [rule.when];
    return rule.event === event && parts.every((part) => text.includes(part)) && eligible(rule, at, past);
  });
  return index < 0 ? undefined : { rule: rules[index]!, index };
}

/** The context tokens of the transcript's latest `message.usage`, and the transcript's bytes. */
function usage(): { ctx_tokens?: number; bytes?: number } {
  const path = String(payload.transcript_path ?? "");
  if (!existsSync(path)) return {};
  for (const line of lines(path).reverse()) {
    const found = (JSON.parse(line) as { message?: { usage?: Record<string, number> } }).message?.usage;
    if (found) {
      const tokens =
        (found.input_tokens ?? 0) + (found.cache_creation_input_tokens ?? 0) + (found.cache_read_input_tokens ?? 0);
      return { ctx_tokens: tokens, bytes: statSync(path).size };
    }
  }
  return { bytes: statSync(path).size };
}

function wide(fields: Record<string, unknown>): void {
  mkdirSync(join(eden, "hook.log.d"), { recursive: true });
  appendFileSync(join(eden, "hook.log.d", "events.jsonl"), JSON.stringify(fields) + "\n");
}

if (reference && event === "PreToolUse" && payload.tool_name === "Agent") {
  const input = payload.tool_input as { subagent_type?: string; prompt?: string };
  appendFileSync(join(data, "spawn.log"), JSON.stringify({ type: input.subagent_type, task: input.prompt }) + "\n");
}

const hit = matching();
let output: Record<string, string> | undefined;
if (hit && (hit.rule.context !== undefined || hit.rule.decision !== undefined)) {
  output = { hookEventName: event };
  if (hit.rule.context !== undefined) output.additionalContext = hit.rule.context;
  if (hit.rule.decision !== undefined) output.permissionDecision = hit.rule.decision;
  if (hit.rule.reason !== undefined) output.permissionDecisionReason = hit.rule.reason;
}

if (reference) {
  if (hit) appendFileSync(join(data, "fired.log"), `${hit.index}\t${hit.rule.tag ?? ""}\n`);
  if (process.env.SCRIPTED_EPISODES === "1" && event === "UserPromptSubmit") {
    appendFileSync(join(eden, "episodes.jsonl"), JSON.stringify({ text: payload.prompt }) + "\n");
  }
  wide({ event, tool_use_id: payload.tool_use_id, ...usage(), label: hit?.rule.log });
  if (event === "PostToolBatch") {
    for (const call of (payload.tool_calls ?? []) as { tool_use_id?: string; tool_response?: unknown }[]) {
      if (/doesn't want to proceed/.test(JSON.stringify(call.tool_response ?? ""))) {
        wide({ event, tool_use_id: call.tool_use_id, label: "declined" });
      }
    }
  }
  const flags = existsSync(join(process.env.HOME ?? "", ".eden", "flags.json"))
    ? (JSON.parse(readFileSync(join(process.env.HOME!, ".eden", "flags.json"), "utf8")) as Record<string, string>)
    : {};
  const flag = flags[FLAG_OF[event] ?? ""];
  if (flag === "shadow" && output) appendFileSync(join(eden, "delivery.shadow.log"), JSON.stringify(output) + "\n");
  if (flag === "off" || flag === "shadow") output = undefined;
}

if (output) process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
