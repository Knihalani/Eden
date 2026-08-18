import { createHash } from "node:crypto";
import type { IslandStep, StepKind, ToolEvent } from "./types";
import { familyId, parseNamedCli, extractNamedCliCalls, isMutatingGh, isMutatingCurl, type ParsedCli } from "./named-cli";
import { githubRestFromCli, parameterizeUrl, toolNameFromUrls } from "./urls";

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
  "TaskCreate",
  "TaskUpdate",
  "TaskOutput",
  "TaskGet",
  "TaskList",
  "TaskStop",
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
  return extractNamedCliCalls(cmd).length === 0;
}

function isChurnEdit(event: ToolEvent): boolean {
  if (!EDIT_LIKE.has(event.name)) return false;
  const old = String(event.args.old_string ?? "");
  return old.length > 400 || String(event.args.new_string ?? "").length > 400;
}

function isIslandMember(event: ToolEvent): boolean {
  if (!event.ok && (event.name === "Read" || event.name === "Grep")) return false;
  if (event.name === "Task" || event.name === "Agent") return false;
  if (event.name.startsWith("Task")) return false;
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
    if (/\bgit\s+(log|status|diff|add|commit|init|checkout|stash)\b/.test(cmd)) return false;
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
  const kind = classifyKind(event, parsed);
  const commute = commutes(kind, parsed, name, cmd, event.name);
  const urlMatch = cmd.match(/https?:\/\/[^\s'"]+/);
  let source_url = urlMatch?.[0];
  if (!source_url && parsed) source_url = githubRestFromCli(parsed, cmd);
  return {
    name,
    cli_family: parsed ? familyId(parsed) : undefined,
    arg_keys: parsed ? parsed.flags : keys,
    constants,
    param_keys: keys.filter((k) => /id$/i.test(k) || k === "issue" || k === "pr" || k === "number" || k === "url"),
    kind,
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

/**
 * May this step be reordered against its neighbours?
 *
 * `commute` is not a hint. buildDag drops the sequential edge for a commuting
 * step so it runs concurrently with the rest of its layer, and dedupeCloudSteps
 * *discards* a commuting step whose parameterised URL matches an earlier one.
 * So a write misclassified here is not merely reordered, it is silently
 * dropped: two identical POSTs to the same endpoint compiled down to one.
 *
 * Three ways that used to happen:
 *  - every curl was commute, because parseNamedCli hardcodes subcommand "get"
 *    for curl and never inspects -X or -d.
 *  - every `gh api` was commute, because its subcommand is the literal string
 *    "api", which matches none of the mutating words that were being tested.
 *  - the verb test was unanchored, so `widget_create`, `set_budget` and
 *    `gadget_purge` all commuted for containing "get".
 */
function commutes(
  kind: IslandStep["kind"],
  parsed: ParsedCli | null | undefined,
  name: string,
  cmd: string,
  eventName?: string,
): boolean {
  if (kind !== "cloud_http") return false;
  if (parsed?.family === "curl") return !isMutatingCurl(cmd);
  if (parsed?.family === "gh") return !isMutatingGh(cmd) && !MUTATING_GH_SUB.test(parsed.subcommand);
  if (eventName === "WebFetch") return true;
  return READ_VERB.test(name);
}

const MUTATING_GH_SUB = /create|merge|close|comment|edit|request|delete|update|add|remove|lock|pin|transfer/i;
/** Anchored to a word start, so "widget_create" is not a read. */
const READ_VERB = /(^|[._\-/])(get|list|view|status|read|show|describe|search|fetch)/i;

function toStepFromParsed(parsed: ParsedCli, cmd: string): IslandStep {
  const name = familyId(parsed);
  const kind = parsed.rewrite_host ? "cloud_http" : "runner";
  const commute = commutes(kind, parsed, name, cmd);
  let source_url = githubRestFromCli(parsed, cmd) || githubRestFromCli(parsed, `gh api ${parsed.positionals[0] || ""}`);
  if (!source_url) {
    const urlMatch = cmd.match(/https?:\/\/[^\s'"]+/);
    source_url = urlMatch?.[0];
  }
  return {
    name,
    cli_family: name,
    arg_keys: parsed.flags,
    constants: {},
    param_keys: [],
    kind,
    commute,
    rewrite_host: parsed.rewrite_host,
    source_url,
  };
}

function explodeSteps(event: ToolEvent): IslandStep[] {
  if (event.name !== "Bash" && event.name !== "bash") return [];
  const cmd = String(event.command ?? event.args.command ?? "");
  return extractNamedCliCalls(cmd)
    .filter((p) => p.family !== "git" && (p.family !== "gh" || Boolean(p.rewrite_host)))
    .map((p) => toStepFromParsed(p, cmd));
}

function dedupeCloudSteps(steps: IslandStep[]): IslandStep[] {
  const seen = new Set<string>();
  const out: IslandStep[] = [];
  for (const s of steps) {
    const key = s.source_url ? parameterizeUrl(s.source_url) : s.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function cutIslands(events: ToolEvent[]): IslandStep[][] {
  const cleaned = cleanEvents(events);
  const islands: IslandStep[][] = [];
  let cur: IslandStep[] = [];
  const flush = () => {
    const steps = dedupeCloudSteps(cur);
    if (steps.length >= 2) islands.push(steps);
    cur = [];
  };
  for (const e of cleaned) {
    const exploded = explodeSteps(e);
    if (exploded.length) {
      cur.push(...exploded);
      continue;
    }
    if (isIslandMember(e)) cur.push(toStep(e));
    else flush();
  }
  flush();
  return islands.filter((island) => island.some((s) => s.kind === "cloud_http" || s.kind === "cloud_oauth"));
}

function stepShape(step: IslandStep): string {
  return step.source_url ? parameterizeUrl(step.source_url) : step.name;
}

function canonicalIsland(steps: IslandStep[]): IslandStep[] {
  const commute = steps.every((s) => s.commute);
  if (!commute) return steps;
  return [...steps].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.arg_keys.join().localeCompare(b.arg_keys.join()) ||
      stepShape(a).localeCompare(stepShape(b)),
  );
}

export function fingerprintIsland(steps: IslandStep[]): string {
  const canonical = canonicalIsland(steps).map((s) => ({
    name: s.name,
    arg_keys: s.arg_keys,
    param_keys: [...s.param_keys].sort(),
    constant_keys: Object.keys(s.constants).sort(),
    kind: s.kind,
    url: stepShape(s),
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function mergeConstantFlip(a: IslandStep[], b: IslandStep[]): IslandStep[] | null {
  if (a.length !== b.length) return null;
  const out: IslandStep[] = [];
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai.name !== bi.name) return null;
    if (ai.arg_keys.join() !== bi.arg_keys.join()) return null;
    const keys = new Set([...Object.keys(ai.constants), ...Object.keys(bi.constants)]);
    const constants: Record<string, string> = {};
    const param_keys = new Set(ai.param_keys);
    for (const k of keys) {
      const av = ai.constants[k];
      if (av !== undefined && av === bi.constants[k]) constants[k] = av;
      else param_keys.add(k);
    }
    out.push({ ...ai, constants, param_keys: [...param_keys] });
  }
  return out;
}

export function requiredK(steps: IslandStep[]): number {
  const head = steps[0];
  if (!head) return 99;
  const first = head.name.split(".")[0]!;
  if (SHARED.has(first) || SHARED.has(head.name) || first === "Bash" || first === "Read") return 2;
  return 1;
}

export function heuristicName(steps: IslandStep[]): string {
  const cloud = steps.filter((s) => s.kind === "cloud_http" || s.kind === "cloud_oauth");
  const urls = cloud.map((s) => s.source_url || "").join(" ");
  if (/\/pulls\//.test(urls)) return "github_pr_bundle";
  if (/\/issues\//.test(urls) && /\/comments/.test(urls)) return "github_issue_bundle";
  if (/\/issues\//.test(urls)) return "github_issue";
  if (/\/commits\/.*\/status/.test(urls)) return "github_commit_status";
  const fromUrls = toolNameFromUrls(cloud.map((s) => s.source_url || "").filter(Boolean));
  if (fromUrls) return fromUrls;
  const names = cloud.map((s) => s.name.replace(/[^a-zA-Z0-9]+/g, "_")).slice(0, 3);
  return names.join("_").slice(0, 48) || "compiled_tool";
}

/** Concatenated family noise is not a product tool. */
export function isCompilableToolName(name: string): boolean {
  if (!name || name === "compiled_tool") return false;
  if (/^gh_api(_gh_api)*$/.test(name)) return false;
  if (/^curl_get(_curl_get)*$/.test(name)) return false;
  return true;
}
