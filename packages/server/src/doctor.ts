#!/usr/bin/env bun
/**
 * `eden doctor` (`bun run doctor`, D852): checks a tenant's integration against each obligation in docs/INTEGRATION.md
 * and says, for each, whether it is met, what missing it measurably costs, and the fix. Silence is Eden's normal
 * answer, so an integration that skips an obligation fails quietly; this names it.
 *
 * Evidence, any of:
 * - the running server's counters for the key's tenant (`/v1/usage`'s `integration`, `IntegrationStats`): event kinds,
 *   the waits sent, pending replies and takes, asks, checks of acting tools, change notices by form, refusals;
 * - an `EDEN_TRACE=1` log (the files given): event kinds per session and asks, for a server that is not reachable;
 * - with `--env`, the configuration where it runs: whether model roles, traces and per-user sources are set up, and
 *   which sources declare that their change notices are forwarded (names and flags only; no value is printed).
 *
 *   bun run doctor [--url http://127.0.0.1:8790] [--json] [--verbose] [--env] [server.log …]
 *
 * The key is `EDEN_API_KEY` (none against a dev server); `--url` defaults to `EDEN_URL`. `--env` adds the server's
 * configuration as this process's environment shows it, so run that where the server runs.
 *
 * Exit 1 when an obligation is not met, 0 otherwise (unknown is not a failure: there was no evidence either way).
 * Content-free: counts only, as the counters and traces are (D56).
 */
import { existsSync, readFileSync } from "node:fs";
import type { IntegrationCounts } from "./integration-stats";
import { readTrace } from "./trace-report";
import { readUsersFile } from "./user-sources";

export type Status = "met" | "unmet" | "unknown";

export interface Finding {
  id: string;
  obligation: string;
  status: Status;
  /** What the evidence shows, in counts. */
  evidence: string;
  /** What missing it costs, as measured (with its source), or "unmeasured". */
  penalty: string;
  fix: string;
}

/** What an `EDEN_TRACE=1` log shows about the integration: event kinds per session, and asks. */
export interface TraceEvidence {
  traces: number;
  events: Record<string, number>;
  sessions: number;
  sessionsStarted: number;
  sessionsWithUser: number;
  sessionsWithAgent: number;
  asks: number;
  /** `{"usage": …}` lines: how each injection's use became known. */
  usage: Record<string, number>;
}

export interface ConfigEvidence {
  /** Variable names set (values are never read into the report). */
  set: Set<string>;
  /** Per-user sources, when `EDEN_USER_SOURCES_FILE` names a readable file. */
  sources?: { users: number; mcp: number; notifying: number; withFetch: number; broken: number };
  sourcesError?: string;
}

/**
 * Traces carry no tenant or user (D56), so sessions are told apart by session id alone: two users' "s1" count once.
 * Pass one tenant's log.
 */
export function traceEvidence(lines: Iterable<string>): TraceEvidence {
  const ev: TraceEvidence = {
    traces: 0,
    events: {},
    sessions: 0,
    sessionsStarted: 0,
    sessionsWithUser: 0,
    sessionsWithAgent: 0,
    asks: 0,
    usage: {},
  };
  const flags = new Map<string, number>();
  for (const line of lines) {
    const t = readTrace(line);
    if (!t) {
      // `{"usage": {...}}` lines (D293): how each injection's use became known; the `how` word only.
      const at = line.indexOf('{"usage"');
      if (at >= 0) {
        try {
          const how = (JSON.parse(line.slice(at)) as { usage?: { how?: unknown } }).usage?.how;
          if (how === "inferred" || how === "expired" || how === "ended" || how === "explicit") {
            ev.usage[how] = (ev.usage[how] ?? 0) + 1;
          }
        } catch {
          // Not a usage line.
        }
      }
      continue;
    }
    ev.traces++;
    if (t.event === "ask" && t.decision === "answer") ev.asks++;
    // One count per event the integration sent: follow-ups (verify, late readers) are the engine's own.
    if (t.decision === "verify" || t.decision === "reader-late" || t.decision === "check-late") continue;
    if (t.decision === "reader-push" || t.event === "ask" || t.event === "source_change") continue;
    ev.events[t.event] = (ev.events[t.event] ?? 0) + 1;
    const bit =
      t.event === "session_start"
        ? 1
        : t.event === "user_message"
          ? 2
          : t.event === "agent_message" || t.event === "tool_call" || t.event === "tool_result"
            ? 4
            : 0;
    flags.set(t.sessionId, (flags.get(t.sessionId) ?? 0) | bit);
  }
  for (const f of flags.values()) {
    ev.sessions++;
    if (f & 1) ev.sessionsStarted++;
    if (f & 2) ev.sessionsWithUser++;
    if (f & 4) ev.sessionsWithAgent++;
  }
  return ev;
}

const CONFIG_NAMES = [
  "EDEN_API_KEYS",
  "EDEN_DEV",
  "EDEN_TRACE",
  "OPENROUTER_API_KEY",
  "EDEN_USER_SOURCES_FILE",
  "EDEN_SOURCES_FILE",
  "EDEN_PROCESSES",
  "EDEN_PERSIST",
  "EDEN_PERSIST_KEY",
  "EDEN_PERSIST_FROZEN_DIR",
] as const;

export function configEvidence(env: Record<string, string | undefined>): ConfigEvidence {
  const set = new Set(CONFIG_NAMES.filter((n) => (env[n] ?? "") !== ""));
  const out: ConfigEvidence = { set };
  const path = env.EDEN_USER_SOURCES_FILE;
  if (!path) return out;
  if (!existsSync(path)) return { ...out, sourcesError: "EDEN_USER_SOURCES_FILE names no file here" };
  try {
    const users = readUsersFile(path);
    const s = { users: users.size, mcp: 0, notifying: 0, withFetch: 0, broken: 0 };
    for (const entry of users.values()) {
      if (!Array.isArray(entry)) {
        s.broken++;
        continue;
      }
      for (const spec of entry) {
        if (spec.kind !== "mcp") continue;
        s.mcp++;
        if (spec.notifies === true) s.notifying++;
        if (spec.fetchTool !== undefined) s.withFetch++;
      }
    }
    out.sources = s;
  } catch (e) {
    // The checker's message names the entry and the rule, never a credential (`SourceConfigError`).
    out.sourcesError = e instanceof Error ? e.message.slice(0, 300) : "unreadable";
  }
  return out;
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : "-");
/** Too few to judge: below this many of the relevant calls an obligation reads unknown. */
const MIN_SAMPLE = 5;

/** Each obligation judged on the evidence given; the order is docs/INTEGRATION.md's loop. */
export function diagnose(input: { counts?: IntegrationCounts; traces?: TraceEvidence; config?: ConfigEvidence }) {
  const { counts: c, traces: t, config } = input;
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);
  const userMessages = c?.events.user_message ?? t?.events.user_message ?? 0;
  const sessions = c?.sessions.seen ?? t?.sessions ?? 0;
  const known = c !== undefined || (t !== undefined && t.traces > 0);

  add({
    id: "report-user-messages",
    obligation: "Report each user message (observe a user_message)",
    status: !known ? "unknown" : userMessages > 0 ? "met" : "unmet",
    evidence: known ? `${userMessages} user messages in ${sessions} sessions` : "no counters or traces",
    penalty: "Without the request Eden has nothing to look up: it stays silent on every turn.",
    fix: 'eden.observe({ kind: "user_message", text }) before each model call of a turn (Python: eden.observe(...)).',
  });

  if (c) {
    const w = c.userWait;
    const sent = w.none + w.short + w.full;
    add({
      id: "wait-on-user-message",
      obligation: "Let the user message's observe wait for its lookup (waitMs about 3,000)",
      // A property of the integration's code, not of traffic: one message is evidence.
      status: sent === 0 ? "unknown" : w.full / sent >= 0.9 ? "met" : "unmet",
      evidence: `${w.full} of ${sent} sent user messages waited 2 s or more; ${w.none} sent no wait, ${w.short} under 2 s`,
      penalty:
        "Measured: with no wait the reader configuration lost 18.2–32.3 points of hidden facts raised on train (D99), " +
        "and 1 s lost 7.6–18.1 (D98); by the lab's timings no wait would have delivered 0 of 11 push packets before " +
        "the agent's first model call (INTEGRATION.md, 'How long to wait').",
      fix: "Leave defaultWaitMs unset (the clients send 3,000 ms on each sent user message); do not pass waitMs: 0.",
    });
  }

  {
    const withUser = c?.sessions.withUser ?? t?.sessionsWithUser ?? 0;
    const withAgent = c?.sessions.withAgent ?? t?.sessionsWithAgent ?? 0;
    add({
      id: "report-agent-side",
      obligation: "Report the agent's side too: its tool calls, tool results and messages",
      status: !known || withUser < MIN_SAMPLE ? "unknown" : withAgent / withUser >= 0.5 ? "met" : "unmet",
      evidence: known ? `${withAgent} of ${withUser} sessions with a user message also reported the agent's side` : "-",
      penalty:
        "Unmeasured in points. Without them Eden cannot see what the agent read or did (tool results feed later " +
        "lookups), and whether its context was used is 'not measured' in the digest (D293).",
      fix: "observe each tool_call, tool_result and agent_message; the proxy and the Hermes plugin do it for you.",
    });
  }

  if (c) {
    const got = c.sessions.gotPending;
    add({
      id: "collect-pending",
      obligation: "Collect what landed later before each model call (collect / pending)",
      status: got < MIN_SAMPLE ? "unknown" : c.sessions.tookPending / got >= 0.5 ? "met" : "unmet",
      evidence: `${c.sessions.tookPending} of ${got} sessions that got a 'pending' reply called /v1/pending after it`,
      penalty:
        "Work that finishes after the wait reaches the agent only this way. Small as measured: late packets were " +
        "taken in 36 of 768 tasks (D704).",
      fix: "messages = withContext(messages, await eden.collect(injection)) before every model call, not only the first.",
    });
  }

  {
    const asks = c?.asks ?? t?.asks ?? 0;
    add({
      id: "ask-context",
      obligation: "Give the agent ask_context as a tool, with Eden's description",
      status: !known || userMessages < 20 ? (asks > 0 ? "met" : "unknown") : asks > 0 ? "met" : "unmet",
      evidence: known ? `${asks} asks over ${userMessages} user messages` : "-",
      penalty:
        "Measured: without the tool the agent raised the decisive fact 11.9 points less often (−0.119, " +
        "−0.196..−0.047; D70), even when the packet already held it.",
      fix:
        "Register eden.ask as a tool with ASK_CONTEXT_DESCRIPTION, use the MCP server's ask_context, or on the " +
        "proxy set EDEN_PROXY_ASK=1 (trial, D851).",
    });
  }

  if (c) {
    add({
      id: "check-acting-tools",
      obligation: "Check each acting tool call before it runs (guardTools)",
      status:
        c.actingToolCalls < MIN_SAMPLE
          ? c.actingChecks > 0
            ? "met"
            : "unknown"
          : c.actingChecks / c.actingToolCalls >= 0.8
            ? "met"
            : "unmet",
      evidence: `${c.actingChecks} checks of acting tools against ${c.actingToolCalls} acting tool calls reported`,
      penalty:
        "Measured: the party check cut injected-mail attacks the agent followed from 12 in 576 tasks to 0, with no " +
        "finding on 576 legitimate calls (A25, D376); it only sees calls you send to check.",
      fix: "tools = guardTools(eden, { send_email, book_meeting }) (Python: guard_tools); the proxy cannot do this.",
    });
  }

  {
    const started = c?.sessions.startedFirst ?? t?.sessionsStarted ?? 0;
    add({
      id: "session-start",
      obligation: "Send session_start when a user connects, before their first request",
      status: !known || sessions < MIN_SAMPLE ? "unknown" : started / sessions >= 0.5 ? "met" : "unmet",
      evidence: known ? `${started} of ${sessions} sessions began with session_start${c ? "" : " (from traces)"}` : "-",
      penalty:
        "Measured on new users: Eden surfaced 48% of hidden facts at second 0 and 78% ten seconds later; the " +
        "backfill starts at the user's first event (D755, docs/research/o4-new-user.md).",
      fix:
        'eden.observe({ kind: "session_start" }) as soon as the user has connected their sources (behind the proxy, ' +
        'send it from your app: POST /v1/events {"kind":"session_start",…}; the proxy sees only model requests).',
    });
  }

  if (c || config) {
    const n = c?.notices;
    const total = n ? n.refs + n.items + n.removed + n.signals : 0;
    const notifying = config?.sources?.notifying ?? 0;
    let status: Status = "unknown";
    let evidence = "no counters";
    if (n) {
      evidence =
        `${total} change notices: ${n.refs} with refs, ${n.items} with items, ${n.removed} removals, ` +
        `${n.signals} bare signals` +
        (config?.sources ? `; ${notifying} of ${config.sources.mcp} sources notify` : "");
      if (total === 0) status = notifying > 0 ? "unmet" : "unknown";
      else status = n.signals > n.refs + n.items ? "unmet" : "met";
    }
    add({
      id: "change-notices",
      obligation: "Forward your sources' change notices, with the refs or items they name",
      status,
      evidence,
      penalty:
        "Measured: bare signals instead of refs put p50 1,013 ms on the agent's request against 6 ms, an ask p50 588 " +
        "ms against 2.3 ms, and 7.4 connector calls a task against 2.0 (A18). With no notice at all, about a third " +
        "of owed updates never arrived (weak-points-1111.md Q5, from the research notes).",
      fix:
        "eden.sourceChanged(sourceId, { refs: changedIds, removed: deletedIds }) from each webhook, and " +
        '"notifies": true on that source in EDEN_USER_SOURCES_FILE.',
    });
  }

  add({
    id: "keep-packets",
    obligation: "Keep each packet in your transcript where it was inserted",
    status: "unknown",
    evidence: "Not visible to the server: check that the message withContext inserted is in the next turn's request.",
    penalty:
      "Measured: dropping packets cost +$0.057 per 1,000 tasks over a user's days on Pi (cache rewrites) and lost " +
      "facts Eden does not send twice in a session (D336).",
    fix: "Append the list withContext returns to your stored transcript; the proxy (keepPackets) and Hermes do it.",
  });

  if (c) {
    const calls = Object.values(c.events).reduce((a, b) => a + b, 0) + c.asks + c.checks + c.pendingCalls;
    add({
      id: "requests-accepted",
      obligation: "Requests accepted: valid ids and bodies",
      // A stray 400 since the server started is not a broken integration: one in a hundred is.
      status: c.refused / Math.max(1, calls + c.refused) < 0.01 ? "met" : "unmet",
      evidence: `${c.refused} requests refused with 400 out of about ${calls + c.refused}`,
      penalty: "A refused request is no context for that turn, and looks exactly like Eden's normal silence.",
      fix: "Map ids with edenId(raw) (Python: eden_id); read what the client's default onError prints (D850).",
    });
    if (calls > 0 && c.shadow >= calls) {
      add({
        id: "shadow",
        obligation: "Shadow mode is a trial, not the integration",
        status: "unmet",
        evidence: `all ${c.shadow} requests were in shadow mode: nothing reached the agent`,
        penalty: "In shadow mode no packet reaches the agent.",
        fix: "Unset EDEN_PROXY_SHADOW (or the client's shadow option) once the trial's traces are read.",
      });
    }
  }

  if (config) {
    const s = config.set;
    add({
      id: "config-auth",
      obligation: "Server config (this machine's environment): API keys set, not dev mode",
      status: s.has("EDEN_API_KEYS") ? "met" : s.has("EDEN_DEV") ? "unmet" : "unknown",
      evidence: s.has("EDEN_API_KEYS")
        ? "EDEN_API_KEYS is set"
        : s.has("EDEN_DEV")
          ? "EDEN_DEV is set"
          : "neither here",
      penalty: "Dev mode accepts any caller as tenant 'dev'.",
      fix: 'EDEN_API_KEYS="acme:<openssl rand -hex 24>" on the server; callers send it as the apiKey.',
    });
    add({
      id: "config-sources",
      obligation: "Server config (this machine's environment): the users' own sources are configured",
      status: config.sourcesError
        ? "unmet"
        : config.sources
          ? config.sources.broken > 0
            ? "unmet"
            : "met"
          : s.has("EDEN_SOURCES_FILE")
            ? "unknown"
            : "unmet",
      evidence: config.sourcesError
        ? config.sourcesError
        : config.sources
          ? `${config.sources.users} users, ${config.sources.mcp} MCP sources (${config.sources.withFetch} with a ` +
            `fetch tool), ${config.sources.broken} users with a broken entry`
          : s.has("EDEN_SOURCES_FILE")
            ? "only shared static sources (EDEN_SOURCES_FILE)"
            : "no sources configured here",
      penalty: "Eden reads only what it is connected to: with no user sources it has nothing of the user's to give.",
      fix: "EDEN_USER_SOURCES_FILE (or a SourceDirectory), a preset per common server (docs/INTEGRATION.md, D294).",
    });
    add({
      id: "config-traces",
      obligation: "Server config (this machine's environment): traces on (EDEN_TRACE=1)",
      status: s.has("EDEN_TRACE") ? "met" : "unknown",
      evidence: s.has("EDEN_TRACE") ? "EDEN_TRACE is set" : "EDEN_TRACE not set here",
      penalty: "None for the agent; without them you cannot see what Eden did (content-free, D56).",
      fix: "EDEN_TRACE=1 on the server, and keep its stdout.",
    });
  }
  return out;
}

const MARK: Record<Status, string> = { met: "ok   ", unmet: "FIX  ", unknown: "?    " };

export function render(findings: Finding[], verbose = false): string {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${MARK[f.status]}${f.obligation}`, `     seen: ${f.evidence}`);
    // The cost and the fix for what needs fixing; `--verbose` for the unknown ones too (a first run has many).
    if (f.status === "unmet" || (f.status === "unknown" && verbose)) {
      lines.push(`     cost: ${f.penalty}`, `     fix:  ${f.fix}`);
    }
  }
  const unmet = findings.filter((f) => f.status === "unmet").length;
  const unknown = findings.filter((f) => f.status === "unknown").length;
  lines.push(
    "",
    `${unmet} to fix, ${unknown} unknown (no evidence either way yet: normal on a first run; --verbose for each one's ` +
      `cost and fix), ${findings.length - unmet - unknown} ok` +
      (unmet ? ". Exit status 1: something to fix (for CI)." : ""),
  );
  return lines.join("\n");
}

/** The tenant's counters from a running server; null with the reason when it cannot be read. */
export async function fetchCounts(
  url: string,
  apiKey: string | undefined,
  doFetch: typeof fetch = fetch,
): Promise<{ counts: IntegrationCounts } | { error: string }> {
  try {
    const res = await doFetch(`${url.replace(/\/$/, "")}/v1/usage`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok)
      return { error: `the server answered ${res.status}${res.status === 401 ? " (check EDEN_API_KEY)" : ""}` };
    const body = (await res.json()) as { integration?: IntegrationCounts };
    if (!body.integration) return { error: "the server is older than D852 (no integration counters)" };
    return { counts: body.integration };
  } catch (e) {
    return { error: `cannot reach ${url.replace(/\/\/[^/@]*@/, "//")} (${e instanceof Error ? e.name : "error"})` };
  }
}

async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const at = argv.indexOf("--url");
  const url = at >= 0 ? argv[at + 1]! : (process.env.EDEN_URL ?? "http://127.0.0.1:8790");
  const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--url");
  const noServer = argv.includes("--no-server");
  let counts: IntegrationCounts | undefined;
  let note = "";
  if (!noServer) {
    const got = await fetchCounts(url, process.env.EDEN_API_KEY);
    if ("counts" in got) counts = got.counts;
    else note = `server counters: ${got.error}`;
  }
  let traces: TraceEvidence | undefined;
  if (files.length) {
    try {
      traces = traceEvidence(files.flatMap((f) => readFileSync(f, "utf8").split("\n")));
    } catch (e) {
      console.error(`eden doctor: cannot read the log (${e instanceof Error ? e.message.slice(0, 200) : "error"})`);
      return 2;
    }
  }
  // The server's configuration is read from this process's environment, so only on request: run with --env where the
  // server runs (its container), or the lines describe the wrong machine.
  const env = argv.includes("--env");
  const findings = diagnose({ counts, traces, ...(env ? { config: configEvidence(process.env) } : {}) });
  if (json) console.log(JSON.stringify({ findings, ...(note ? { note } : {}) }, null, 2));
  else {
    if (note) console.log(`(${note}; judged on ${traces ? "the log and " : ""}the configuration only)\n`);
    console.log(render(findings, argv.includes("--verbose")));
  }
  return findings.some((f) => f.status === "unmet") ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
