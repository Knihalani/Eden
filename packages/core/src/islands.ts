import { createHash } from "node:crypto";
import type { IslandStep, StepKind, ToolEvent } from "./types";
import { familyId, parseNamedCli } from "./named-cli";

const SHARED = new Set(["Read", "Bash", "Write", "Edit", "Grep", "Glob", "get_customer"]);
const EDIT_LIKE = new Set(["Edit", "Write", "NotebookEdit"]);
const MCP_HINT = /^(mcp__|linear|github|slack|notion)/i;
const CODING_NATIVE = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "bash",
  "Grep",
  "Glob",
  "Task",
  "Agent",
  "NotebookEdit",
  "TodoWrite",
  "Skill",
  "WebFetch",
  "WebSearch",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
]);

function isMcp(name: string): boolean {
  return MCP_HINT.test(name) || name.includes("__");
}

function argKeys(args: Record<string, unknown>): string[] {
  return Object.keys(args).sort();
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function classifyKind(event: ToolEvent, parsed: ReturnType<typeof parseNamedCli>): StepKind {
  if (parsed?.rewrite_host) return "cloud_http";
  if (isMcp(event.name) && !EDIT_LIKE.has(event.name)) return "cloud_http";
  if (event.name === "WebFetch" || event.name === "WebSearch") return "cloud_http";
  if (!CODING_NATIVE.has(event.name)) return "cloud_http";
  return "runner";
}

function isGenericBash(event: ToolEvent): boolean {
  if (event.name !== "Bash" && event.name !== "bash") return false;
  const cmd = String(event.command ?? event.args.command ?? "");
  return parseNamedCli(cmd) === null;
}

function isChurnEdit(event: ToolEvent): boolean {
  if (!EDIT_LIKE.has(event.name)) return false;
  const old = String(event.args.old_string ?? "");
  return old.length > 400 || String(event.args.new_string ?? "").length > 400;
}

function isIslandMember(event: ToolEvent): boolean {
  if (!event.ok && (event.name === "Read" || event.name === "Grep")) return false;
  if (event.name === "Task" || event.name === "Agent") return false;
  if (isChurnEdit(event)) return false;
  if (isGenericBash(event)) return false;
  if (EDIT_LIKE.has(event.name)) return false;
  if (event.name === "Read") {
    const path = String(event.args.file_path ?? event.args.path ?? "");
    return /\.(json|ya?ml|toml|env|lock)$/.test(path);
  }
  if (isMcp(event.name)) return true;
  if (event.name === "WebFetch" || event.name === "WebSearch") return true;
  if (event.name === "Bash" || event.name === "bash") {
    const cmd = String(event.command ?? event.args.command ?? "");
    return parseNamedCli(cmd) !== null;
  }
  // Product-agent SDK verbs (get_issue, list_comments, …) are islands.
  if (!CODING_NATIVE.has(event.name)) return true;
  return false;
}

function toStep(event: ToolEvent): IslandStep {
  const cmd = String(event.command ?? event.args.command ?? "");
  const parsed = event.name === "Bash" || event.name === "bash" ? parseNamedCli(cmd) : null;
  const keys = (parsed ? parsed.flags : argKeys(event.args)).filter((k) => k !== "command");
  const constants: Record<string, string> = {};
  for (const k of argKeys(event.args)) {
    if (k === "command" || /id$/i.test(k) || k === "issue" || k === "pr" || k === "number" || k === "url") continue;
    const s = asString(event.args[k]);
    if (s !== null && s.length < 80 && !s.includes("\n")) constants[k] = s;
  }
  const name = parsed ? familyId(parsed) : event.name;
  const commute = classifyKind(event, parsed) === "cloud_http" && (parsed?.family === "curl" || event.name === "WebFetch" || /get|list|view|status/i.test(name));
  const urlMatch = cmd.match(/https?:\/\/[^\s'"]+/);
  let source_url = urlMatch?.[0];
  if (!source_url && parsed?.family === "gh" && parsed.subcommand === "api" && parsed.positionals[0]) {
    source_url = `https://api.github.com/${parsed.positionals[0].replace(/^\//, "")}`;
  }
  return {
    name,
    cli_family: parsed ? familyId(parsed) : undefined,
    arg_keys: parsed ? parsed.flags : keys,
    constants,
    param_keys: keys.filter((k) => /id$/i.test(k) || k === "issue" || k === "pr" || k === "number" || k === "url"),
    kind: classifyKind(event, parsed),
    commute,
    rewrite_host: parsed?.rewrite_host,
    source_url,
  };
}

export function cleanEvents(events: ToolEvent[]): ToolEvent[] {
  const out: ToolEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev && prev.name === e.name && JSON.stringify(prev.args) === JSON.stringify(e.args)) {
      out[out.length - 1] = e;
      continue;
    }
    out.push(e);
  }
  return out;
}

export function cutIslands(events: ToolEvent[]): IslandStep[][] {
  const cleaned = cleanEvents(events);
  const islands: IslandStep[][] = [];
  let cur: IslandStep[] = [];
  const flush = () => {
    if (cur.length >= 2) islands.push(cur);
    cur = [];
  };
  for (const e of cleaned) {
    if (isIslandMember(e)) cur.push(toStep(e));
    else flush();
  }
  flush();
  return islands.filter((island) => island.some((s) => s.kind === "cloud_http" || s.kind === "cloud_oauth"));
}

function canonicalIsland(steps: IslandStep[]): IslandStep[] {
  const commute = steps.every((s) => s.commute);
  if (!commute) return steps;
  return [...steps].sort((a, b) => a.name.localeCompare(b.name) || a.arg_keys.join().localeCompare(b.arg_keys.join()));
}

export function fingerprintIsland(steps: IslandStep[]): string {
  const canonical = canonicalIsland(steps).map((s) => ({
    name: s.name,
    arg_keys: s.arg_keys,
    param_keys: [...s.param_keys].sort(),
    constant_keys: Object.keys(s.constants).sort(),
    constants: s.constants,
    kind: s.kind,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function mergeConstantFlip(a: IslandStep[], b: IslandStep[]): IslandStep[] | null {
  if (a.length !== b.length) return null;
  const out: IslandStep[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name) return null;
    if (a[i].arg_keys.join() !== b[i].arg_keys.join()) return null;
    const keys = new Set([...Object.keys(a[i].constants), ...Object.keys(b[i].constants)]);
    const constants: Record<string, string> = {};
    const param_keys = new Set(a[i].param_keys);
    for (const k of keys) {
      if (a[i].constants[k] === b[i].constants[k]) constants[k] = a[i].constants[k];
      else param_keys.add(k);
    }
    out.push({ ...a[i], constants, param_keys: [...param_keys] });
  }
  return out;
}

export function requiredK(steps: IslandStep[]): number {
  if (steps.length === 0) return 99;
  const first = steps[0].name.split(".")[0];
  if (SHARED.has(first) || SHARED.has(steps[0].name) || first === "Bash" || first === "Read") return 2;
  return 1;
}

export function heuristicName(steps: IslandStep[]): string {
  const names = steps.map((s) => s.name.replace(/[^a-zA-Z0-9]+/g, "_")).slice(0, 3);
  return names.join("_").slice(0, 48) || "compiled_tool";
}
