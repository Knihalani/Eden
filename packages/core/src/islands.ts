import { createHash } from "node:crypto";
import type { IslandStep, StepKind, ToolEvent } from "./types";
import { familyId, parseNamedCli, extractNamedCliCalls, isMutatingGh, isMutatingCurl, type ParsedCli } from "./named-cli";
import { githubRestFromCli, parameterizeUrl, toolNameFromUrls } from "./urls";
import { commandShape, isNoiseCommand, abstractShellGroup } from "./shapes";

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

/**
 * Domain-general CLI membership.
 *
 * This used to be a hard exclusion: any Bash event without a gh/curl-shaped
 * call was "generic bash" and could never join an island, which made every
 * kubectl/aws/stripe/psql loop in the world uncompilable — the compiler was
 * overfitted to one vendor. Now an unknown binary still qualifies, via its
 * command shape (binary + subcommand + flags), as long as it is not session
 * plumbing (cd/ls/echo…). Safety is unchanged: generic steps compile as
 * `runner` kind and runner steps never commute, so a misread command is at
 * worst sequential — exactly what the agent did by hand — never reordered,
 * never deduped away.
 */
function isGenericBash(event: ToolEvent): boolean {
  if (event.name !== "Bash" && event.name !== "bash") return false;
  const cmd = String(event.command ?? event.args.command ?? "");
  if (extractNamedCliCalls(cmd).length > 0) return false;
  if (!commandShape(cmd)) return true;
  return isNoiseCommand(cmd);
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
    if (parseNamedCli(cmd) !== null) return true;
    // Domain-general CLI work (kubectl, aws, stripe, psql, …). Noise was
    // already filtered by isGenericBash above; whatever remains carries a
    // usable command shape.
    return true;
  }
  // Product-agent SDK verbs (get_issue, list_comments, …) are islands.
  if (!CODING_NATIVE.has(event.name)) return true;
  return false;
}

function toStep(event: ToolEvent): IslandStep {
  const cmd = String(event.command ?? event.args.command ?? "");
  const parsed = event.name === "Bash" || event.name === "bash" ? parseNamedCli(cmd) : null;
  // Domain-general fallback: an unknown binary is named by its own shape
  // (binary + subcommand path) rather than by the transport ("Bash"), which
  // would collapse every unrelated command onto one step identity.
  const shape = parsed ? null : commandShape(cmd);
  const keys = (parsed ? parsed.flags : shape ? [...shape.flags] : argKeys(event.args)).filter((k) => k !== "command");
  const constants: Record<string, string> = {};
  for (const k of argKeys(event.args)) {
    if (k === "command" || /id$/i.test(k) || k === "issue" || k === "pr" || k === "number" || k === "url") continue;
    const s = asString(event.args[k]);
    if (s !== null && s.length < 80 && !s.includes("\n")) constants[k] = s;
  }
  const name = parsed ? familyId(parsed) : shape ? shape.name : event.name;
  const kind = classifyKind(event, parsed);
  const commute = commutes(kind, parsed, name, cmd, event.name);
  const urlMatch = cmd.match(/https?:\/\/[^\s'"]+/);
  let source_url = urlMatch?.[0].replace(/[;,)]+$/, "");
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
    // Raw command kept on shell-derived steps so island-level abstraction
    // (abstractShellSteps) can re-derive their identity from peer variation.
    command: !parsed && shape ? cmd : undefined,
  };
}

export function cleanEvents(events: ToolEvent[]): ToolEvent[] {
  const out: ToolEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    // Two guards against silent under-execution. First, the comparison
    // includes the command: hook recordings carry the command at the top
    // level with args left {}, so name+args alone collapsed two *different*
    // calls into one. Second, a mutating call never collapses, not even a
    // byte-identical repeat — two identical POSTs are two writes (double
    // recording by hook + proxy is only harmless for reads). Mutation here is
    // an allowlist, following the same philosophy as commutes(): a shell
    // event's mutation comes from its COMMAND via the curl/gh write
    // heuristics; any other event's mutation comes from its NAME, which must
    // positively classify as a read — no mutating word anywhere, and a READ
    // word at the head only (see nameIsRead) — to ever collapse. The old
    // shell-only guard let byte-identical mcp__linear__create_issue /
    // create_record repeats collapse into one because neither heuristic had
    // ever heard of them: silent under-execution. Provably-read repeats
    // still dedupe.
    const cmd = e.command ?? "";
    const shell = e.name === "Bash" || e.name === "bash";
    // Shell events fail CLOSED: explicit curl/gh write markers mutate, and
    // anything else must positively prove itself read via its command shape.
    // The old default (no marker ⇒ read) collapsed byte-identical repeats of
    // `terraform destroy` / `psql -c "INSERT …"` for every vendor the
    // domain-general path exists to serve — under-execution by dedupe.
    const shape = shell && cmd ? commandShape(cmd) : undefined;
    // Named CLI calls keep marker-based classification (a bare `curl URL` is
    // a GET with no read verb to prove); generic shells need shape proof.
    const hasNamedCli = Boolean(cmd && extractNamedCliCalls(cmd).length);
    const mutating =
      Boolean(cmd && (isMutatingCurl(cmd) || isMutatingGh(cmd))) ||
      (!shell && !nameIsRead(e.name)) ||
      (shell && !hasNamedCli && (!shape || shape.possiblyRead !== true));
    if (
      prev &&
      !mutating &&
      prev.name === e.name &&
      JSON.stringify(prev.args) === JSON.stringify(e.args) &&
      (prev.command ?? "") === cmd
    ) {
      out[out.length - 1] = e;
      continue;
    }
    out.push(e);
  }
  return out;
}

/**
 * Positive read classification for a tool-event NAME.
 *
 * This mirrors the discipline of packages/ir/src/names.ts (isMutating +
 * isReadName). It is duplicated locally because core does NOT depend on
 * @eden/ir — if either vocabulary changes, align the other.
 *
 * Three rules, in order:
 *  1. The name is word-broken over camelCase boundaries and the `__ . _ - /`
 *     delimiters first.
 *  2. ANY mutating word anywhere makes the name a write: compound verbs like
 *     getOrCreateRecord, readThenWrite and listAndCharge mutate, and so does
 *     update_status for carrying "update" at all. The old unanchored READ_VERB
 *     matched the "get"/"read"/"list"/"status" fragments inside exactly those
 *     names, so their byte-identical repeats collapsed into one call — silent
 *     under-execution.
 *  3. Otherwise a READ word must sit at the HEAD position only (the first word
 *     after any mcp__server__ transport prefix), from a conservative vocabulary
 *     matching ir/names.ts's READ_NAME (view/status/show-style heads are not
 *     trusted there either). Anything unmatched fails closed: an unknown name
 *     never collapses.
 */
const MUTATING_WORDS = [
  // Copied from packages/ir/src/names.ts MUTATING_VERBS:
  "write",
  "create",
  "update",
  "delete",
  "send",
  "notify",
  "post",
  "put",
  "patch",
  "insert",
  "remove",
  "destroy",
  "drop",
  "publish",
  "upsert",
  // Core extensions for compound tool names ir has not met yet:
  "set",
  "add",
  "merge",
  "close",
  "cancel",
  "charge",
  "deploy",
  "run",
  "execute",
  "trigger",
  "rotate",
  "revoke",
  "invite",
  "comment",
  "reply",
  "submit",
  "approve",
  "pay",
  "refund",
];
// Mirrors READ_NAME in packages/ir/src/names.ts.
const READ_WORDS = ["lookup", "fetch", "get", "read", "list", "search", "find", "describe", "show", "head"];
/** Coding-native tools we name ourselves and know are reads. */
const NATIVE_READS = new Set(["WebFetch", "WebSearch"]);

/** Split a tool name into words: snake, kebab, dotted, slashed and camel all count. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function nameIsRead(name: string): boolean {
  if (NATIVE_READS.has(name)) return true;
  // mcp__linear__get_issue carries its verb after the server prefix; judge the
  // effective tool name, not the transport decoration.
  const effective = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  const words = nameWords(effective);
  if (words.some((w) => MUTATING_WORDS.includes(w))) return false;
  const head = words[0];
  return Boolean(head && READ_WORDS.includes(head));
}

/**
 * Commute-safety for a step NAME, stricter on compounds, looser on dotted
 * product names.
 *
 * Two failure classes had to be excluded simultaneously:
 *  - compound heads that EMBED a mutation after a read verb
 *    (`fetchAndChargeCard`, `listAndDeleteSessions`) — the head-match used to
 *    commute these, and dedupeCloudSteps then DROPPED their siblings;
 *  - dotted product verbs where the head is a noun (`order.view`,
 *    `status.check`) — requiring the verb at the head refused these.
 *
 * Rule: any mutating word anywhere ⇒ write; otherwise a head read-word OR a
 * separator-anchored read verb ⇒ read; else write.
 */
function nameIsSafeRead(name: string): boolean {
  const effective = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  const words = nameWords(effective);
  if (words.some((w) => MUTATING_WORDS.includes(w))) return false;
  if (nameIsRead(name)) return true;
  return READ_VERB.test(effective);
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
  // nameIsSafeRead, not a bare anchored head-match: compound heads like
  // fetchAndChargeCard / listAndDeleteSessions start with a read verb and
  // used to commute here, so dedupeCloudSteps DROPPED their byte-different
  // siblings — silent under-execution on MCP product tools. Dotted product
  // verbs (order.view) keep commuting via the separator-anchored fallback.
  return nameIsSafeRead(name);
}

const MUTATING_GH_SUB = /create|merge|close|comment|edit|request|delete|update|add|remove|lock|pin|transfer/i;
/** Anchored to a word start, so "widget_create" is not a read. */
const READ_VERB = /(^|[._\-/])(get|list|view|status|read|show|describe|search|fetch)/i;

function toStepFromParsed(parsed: ParsedCli, cmd: string): IslandStep {
  const name = familyId(parsed);
  const kind = parsed.rewrite_host ? "cloud_http" : "runner";
  const commute = commutes(kind, parsed, name, cmd);
  // The call's OWN positional is the URL — falling through to a match on the
  // whole command string gave every curl in a multi-call line the FIRST
  // call's URL, so dedupeCloudSteps then collapsed genuinely different
  // resources into one step.
  let source_url =
    githubRestFromCli(parsed, cmd) || githubRestFromCli(parsed, `gh api ${parsed.positionals[0] || ""}`);
  if (!source_url) {
    const own = parsed.positionals.find((p) => /^https?:\/\//.test(p));
    if (own) source_url = own;
    else source_url = cmd.match(/https?:\/\/[^\s'"]+/)?.[0];
  }
  source_url = source_url?.replace(/[;,)]+$/, "");
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
    // Only commuting (read) steps may collapse onto a parameterised shape.
    // Two writes to the same shape — POST /issues/5/comments then
    // POST /issues/7/comments — are two mutations; dropping the second
    // silently under-executed the compiled tool.
    if (!s.commute) {
      out.push(s);
      continue;
    }
    const key = s.source_url ? parameterizeUrl(s.source_url) : s.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Re-derive shell step identities from peer variation within one island.
 *
 * toStep names each command by its own shape, so `kubectl logs api -n dev`
 * and `kubectl logs web -n stage` land as two unrelated steps. Within an
 * island they are siblings: abstractShellGroup's variation vote (constant
 * tokens = structure, varying = slot) gives them the shared skeleton identity
 * mining needs, while genuinely different commands keep distinct skeletons.
 */
function abstractShellSteps(steps: IslandStep[], peers?: string[]): IslandStep[] {
  const shellIdx = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.command && s.kind === "runner" && !s.cli_family);
  if (shellIdx.length < 1) return steps;
  // Prior runs' shell commands vote alongside this run's: `kubectl logs api`
  // alone has no variation evidence, but with yesterday's `logs web` as a
  // peer the pod token slots and both land on one skeleton identity.
  const own = shellIdx.map(({ s }) => s.command!);
  const names = abstractShellGroup([...(peers?.length ? peers : []), ...own]);
  if (!names.size) return steps;
  // Skeletons can legitimately collide inside one island (`get pods` vs
  // `get svc` with two witnesses slot the resource token identically).
  // Sequence position is what distinguishes them, so collisions take a
  // deterministic occurrence suffix rather than silently sharing identity.
  const seen = new Map<string, number>();
  return steps.map((s) => {
    const renamed = names.get(s.command ?? "");
    if (!renamed || !s.command || s.kind !== "runner" || s.cli_family) return s;
    const n = seen.get(renamed) ?? 0;
    seen.set(renamed, n + 1);
    return n === 0 ? { ...s, name: renamed } : { ...s, name: `${renamed}-${n + 1}` };
  });
}

/**
 * Domain-general shell-loop decomposition.
 *
 * `for n in 170 169; do kubectl describe pod web-$n; done` records as ONE
 * Bash event, so mining saw a single opaque command where the agent actually
 * did two pieces of work. Substituting the loop variable turns it into the
 * per-item events the agent effectively issued; from there the normal path
 * applies — named-CLI extraction, shape membership, peer-voted skeletons.
 *
 * Conservative on purpose: exactly one plain `for…in…; do…; done` spanning
 * the whole command, variable referenced in the body, 2–100 items. Anything
 * else (nesting, pipes into the loop, conditionals) stays unexploded.
 */
export function explodeShellLoop(event: ToolEvent): ToolEvent[] {
  if (event.name !== "Bash" && event.name !== "bash") return [];
  const cmd = String(event.command ?? event.args.command ?? "");
  const m = cmd.match(/^\s*for\s+([A-Za-z_]\w*)\s+in\s+([^;]+);\s*do\s*([\s\S]*?)\s*;\s*done\s*;?\s*$/);
  if (!m) return [];
  const varName = m[1]!;
  const body = m[3]!;
  if (!body.includes(`$${varName}`) && !body.includes(`\${${varName}}`)) return [];
  const items = m[2]!.trim().split(/\s+/);
  if (items.length < 2 || items.length > 100) return [];
  const substitute = (item: string) =>
    body.replaceAll(`\${${varName}}`, item).replaceAll(`$${varName}`, item);
  return items.map((item, i) => ({
    event_id: `${event.event_id}-l${i}`,
    seq: event.seq,
    name: event.name,
    args: { ...(event.args ?? {}), command: substitute(item) },
    command: substitute(item),
    ok: event.ok,
  }));
}

export function cutIslands(
  events: ToolEvent[],
  opts: {
    /** Keep islands made purely of runner (laptop) steps? Hosted tools need cloud; local registries run these. */
    allowRunnerOnly?: boolean;
    /** Shell commands from prior ingests, so variation evidence accumulates across runs. */
    peerCommands?: string[];
  } = {},
): IslandStep[][] {
  const cleaned = cleanEvents(events);
  const islands: IslandStep[][] = [];
  let cur: IslandStep[] = [];
  const flush = () => {
    let steps = dedupeCloudSteps(cur);
    steps = abstractShellSteps(steps, opts.peerCommands);
    if (process.env.EDEN_DEBUG_ISLANDS === "1") {
      console.error("[flush]", cur.length, "->", steps.length, steps.map((s) => [s.name, s.kind, s.source_url]));
    }
    if (steps.length >= 2) islands.push(steps);
    cur = [];
  };
  for (const e of cleaned) {
    // Loop decomposition FIRST: extractNamedCliCalls matches curl/gh inside
    // `for` bodies and short-circuited the per-item substitution, so a
    // three-write loop became one template step (or vanished in dedupe).
    // After substitution each item flows through the normal path, keeping
    // the richer named-CLI handling per call.
    const loop = explodeShellLoop(e);
    if (loop.length) {
      let broke = false;
      for (const sub of loop) {
        const subExploded = explodeSteps(sub);
        if (subExploded.length) {
          cur.push(...subExploded);
          continue;
        }
        if (isIslandMember(sub)) {
          cur.push(toStep(sub));
          continue;
        }
        flush();
        broke = true;
        break;
      }
      continue;
    }
    const exploded = explodeSteps(e);
    if (exploded.length) {
      cur.push(...exploded);
      continue;
    }
    if (isIslandMember(e)) cur.push(toStep(e));
    else flush();
  }
  flush();
  return islands.filter(
    (island) =>
      opts.allowRunnerOnly ||
      island.some((s) => s.kind === "cloud_http" || s.kind === "cloud_oauth"),
  );
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
  // Generic first: the resource chain across the island's URLs, prefixed by
  // the provider slug when the host says something useful. This is
  // domain-general — any SaaS — and vendor bundle names are now just what the
  // chain happens to compress to on GitHub-shaped data.
  const fromUrls = toolNameFromUrls(cloud.map((s) => s.source_url || "").filter(Boolean));
  if (fromUrls) return fromUrls;

  // Verb-chain fallback for shape-named CLI steps (kubectl.get.pods …).
  const shaped = steps.filter((s) => s.cli_family === undefined && s.kind === "runner" && s.name.includes("."));
  if (shaped.length) {
    const parts = [...new Set(shaped.map((s) => s.name.split(".").slice(0, 2).join("_")))].slice(0, 3);
    const joined = parts.join("_");
    if (joined && !/^[._\-/]+$/.test(joined)) return joined.slice(0, 48);
  }

  // Vendor bundle recognition last: it is one dataset among many, not the
  // centre of the compiler. Kept because these names are established on
  // dashboards and in stored tools.
  const urls = cloud.map((s) => s.source_url || "").join(" ");
  if (/\/pulls\//.test(urls)) return "github_pr_bundle";
  if (/\/issues\//.test(urls) && /\/comments/.test(urls)) return "github_issue_bundle";
  if (/\/issues\//.test(urls)) return "github_issue";
  if (/\/commits\/.*\/status/.test(urls)) return "github_commit_status";

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
