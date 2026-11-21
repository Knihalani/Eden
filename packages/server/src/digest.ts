#!/usr/bin/env bun
/**
 * `bun run digest [log ...] [--baseline LOG] [--json]` (D293): "Eden caught this", a content-light report an
 * integrator can show stakeholders, over a server's `EDEN_TRACE=1` log (the files given, or stdin): how often Eden
 * added context and what kind, from which connectors, how often the agent then used it, how often it stayed silent
 * and why, and its time and request-time spend. Built only on what the log already holds, which is content-free
 * (D56): decision traces (`trace-report`'s input) and usage records (`{"usage": …}` lines, `onUsage`, D293). It
 * prints counts, shares, connector ids and percentiles; never an item id, a request or an item's text.
 *
 * "Used" is the engine's inference (D18: a later agent message or tool call repeats the injection's distinctive
 * terms) or the integration's explicit feedback (D13). It is coarse: it is per injection, so a packet of five
 * candidates counts as used when the agent repeats any one of them, and it misses use in other words. It is only
 * measured when the integration reports the agent's own messages or tool calls, or sends feedback: without either
 * the digest says "not measured" rather than 0%. Traces carry no clock, so the period is whatever log is given (a
 * day's, a week's).
 *
 * Connector calls: the agent's own reported tool calls, Eden's calls inside lookups (the traces' `sourceCalls`) and
 * its background sync's listings (`{"sync": ...}` lines, logged once a minute per process), per 1,000 user requests,
 * priced on market.py's plans. "Without Eden" needs a second log of the agent without Eden's context (`--baseline`:
 * the proxy's shadow mode reports events but injects nothing).
 */
import { explainTrace, type Trace, type UsageRecord } from "@eden/engine";
import { isId } from "@eden/protocol";
import { readTrace, traceReport, type TraceReport } from "./trace-report";

/** What kind of help a trace that spoke gave, in words a stakeholder reads. */
export type Kind = "conflict" | "candidates" | "match" | "cached" | "answer" | "update" | "judged" | "party";

const KIND_WORDS: Record<Kind, string> = {
  conflict: "a clash or a person/day match with the request (no model)",
  candidates: "items to check before an action (the request acts)",
  match: "a confident match from a source search",
  cached: "a confident match from the user's synced items",
  answer: "answers to the agent's own questions (ask_context)",
  update: "a newer version of something already shown",
  judged: "a match a model judged",
  party: "a finding on a tool call about to run (the party check)",
};

/** Connector plans, $ per 1,000 tool calls (packages/sim/lab/before-after/market.py's `CONNECTORS`). */
export const CONNECTOR_PLANS: Readonly<Record<string, number>> = {
  "First-party APIs (quota only)": 0,
  "Composio (overage)": 0.3,
  "Unified.to (Pro)": 0.75,
  "Arcade.dev (Team)": 10,
  "Pipedream Connect (overage)": 12,
  "Zapier MCP (10k tasks)": 25.8,
};

/** Connector calls in a log, per user request. */
export interface ConnectorCalls {
  /** User messages observed: the requests the calls are spread over. */
  requests: number;
  /** The agent's own tool calls reported to Eden (`tool_call` events): an upper bound on its connector calls. */
  agent: number;
  /** Eden's calls inside lookups (the traces' `sourceCalls`, on-demand sync polls included). */
  edenRequest: number;
  /**
   * Eden's background sync listings (backfill, sweeps): the last `{"sync": ...}` counter per process, summed. Null
   * when the log holds none (no sync, or a log shorter than a minute).
   */
  edenBackground: number | null;
}

export interface Digest {
  events: number;
  sessionIds: number;
  /** Events after which Eden handed the agent items (trace-report's `spoke`). */
  added: number;
  /** Traces that handed items, by kind, and the items they carried by connector id. */
  kinds: Partial<Record<Kind, number>>;
  sources: Record<string, number>;
  asks: { total: number; withItems: number };
  /** Usage records, last word per injection (a correction replaces the earlier outcome). */
  used: {
    measured: boolean;
    injections: number;
    used: number;
    explicit: number;
    bySource: Record<string, { injections: number; used: number }>;
  };
  /**
   * Packet text handed to the agent (C1): UTF-8 bytes summed over the usage records that name them, and how
   * many did. The agent's model re-reads a session's packets on every later request; roughly four bytes a
   * token. A record from before the field shipped carries none, so a log mixing versions undercounts.
   */
  packets: { bytes: number; counted: number; total: number };
  silent: { events: number; reasons: Record<string, number>; nothingToLookUp: number };
  connectors: ConnectorCalls;
  /** The same counts from a log without Eden's context (`--baseline`: shadow mode, or before Eden), if given. */
  baseline?: ConnectorCalls;
  report: TraceReport;
}

function isUsage(v: unknown): v is { usage: UsageRecord } {
  if (!v || typeof v !== "object") return false;
  const u = (v as { usage?: Record<string, unknown> }).usage;
  return (
    !!u &&
    typeof u.injectionId === "string" &&
    typeof u.used === "boolean" &&
    Array.isArray(u.sourceIds) &&
    // Connector ids are configuration ids (`isId`): anything else in a line is not a connector id to print (A11).
    u.sourceIds.every((s) => isId(s))
  );
}

function kindOf(t: Trace): Kind | null {
  if (t.itemIds.length === 0) return null;
  if (t.reason.startsWith("updated:")) return "update";
  switch (t.decision) {
    case "answer":
      return "answer";
    case "reader-push":
      return "candidates";
    case "model":
      return "judged";
    case "fast":
      return t.reason.startsWith("action-") ? "party" : "cached";
    case "sources":
      return t.reason.startsWith("grounded-") ? "conflict" : "match";
    default:
      return null;
  }
}

/**
 * A connector id from an item id (`itemId`: `<sourceId>:<ref>`); the ref is never kept. A connector id may itself
 * hold a colon (`isId`), so the longest id the log names elsewhere (usage records, plans) that prefixes the item id
 * wins over the first colon; whatever is not an id is "unknown" (audit A11).
 */
const sourceOf = (itemId: string, known: readonly string[]) => {
  const named = known.find((k) => itemId.startsWith(`${k}:`));
  const id = named ?? itemId.slice(0, Math.max(0, itemId.indexOf(":")));
  return isId(id) ? id : "unknown";
};

export function digest(lines: Iterable<string>): Digest {
  const all = [...lines];
  const report = traceReport(all);
  const traces: Trace[] = [];
  const kinds: Partial<Record<Kind, number>> = {};
  const sources: Record<string, number> = {};
  const asks = { total: 0, withItems: 0 };
  const usage = new Map<string, UsageRecord>();
  let agentEvents = 0;
  let nothingToLookUp = 0;
  // Per process run: the counter's segments (a drop starts a new one, for a log written before `run` existed or a
  // restart that kept its pid) and the latest value of the current one.
  const syncRuns = new Map<string, { done: number; last: number }>();
  for (const line of all) {
    const at = line.indexOf("{");
    if (at < 0) continue;
    let v: unknown;
    try {
      v = JSON.parse(line.slice(at));
    } catch {
      continue;
    }
    if (isUsage(v)) {
      // The last word per injection, except that the integration's explicit outcome is never replaced by the engine's
      // own: the engine sends nothing after it, so one that comes later in the log is a line out of order (A11).
      const was = usage.get(v.usage.injectionId);
      if (!(was?.how === "explicit" && v.usage.how !== "explicit")) usage.set(v.usage.injectionId, v.usage);
      continue;
    }
    const sync = (v as { sync?: { run?: unknown; pid?: unknown; backgroundCalls?: unknown } } | null)?.sync;
    if (
      sync &&
      typeof sync.backgroundCalls === "number" &&
      Number.isFinite(sync.backgroundCalls) &&
      sync.backgroundCalls >= 0 &&
      (typeof sync.run === "string" || typeof sync.pid === "number")
    ) {
      // Cumulative per process: within one run the last value is its total; a value below the last is a restart.
      const key = typeof sync.run === "string" ? `run:${sync.run}` : `pid:${String(sync.pid)}`;
      const r = syncRuns.get(key) ?? { done: 0, last: 0 };
      if (sync.backgroundCalls < r.last) r.done += r.last;
      r.last = sync.backgroundCalls;
      syncRuns.set(key, r);
      continue;
    }
    // The same lines trace-report counts, no others (a line it rejects must not count here either).
    const t = readTrace(line);
    if (t) traces.push(t);
  }
  const records = [...usage.values()];
  // Connector ids the log names whole, longest first, so "work:gmail" wins over "work" (see `sourceOf`).
  const known = [
    ...new Set([
      ...records.flatMap((r) => r.sourceIds),
      ...traces.flatMap((t) => (t.plans ?? []).map((p) => p.sourceId)),
    ]),
  ]
    .filter((s) => isId(s))
    .sort((a, b) => b.length - a.length);
  for (const t of traces) {
    if (t.event === "agent_message" || t.event === "tool_call") agentEvents++;
    // A background search B1 started (D405) is not a lookup of its own (as a sync poll behind is not).
    if (t.decision === "skipped" && t.reason !== "sync poll behind" && t.reason !== "cut search behind")
      nothingToLookUp++;
    if (t.decision === "answer") {
      asks.total++;
      if (t.itemIds.length > 0) asks.withItems++;
    }
    const k = kindOf(t);
    if (!k) continue;
    kinds[k] = (kinds[k] ?? 0) + 1;
    for (const id of t.itemIds) {
      const s = sourceOf(id, known);
      sources[s] = (sources[s] ?? 0) + 1;
    }
  }
  // A `reset` record is no verdict — a compaction ended the tracking (D2006); it counts only the handed bytes.
  const verdicts = records.filter((r) => r.how !== "reset");
  const bySource: Digest["used"]["bySource"] = {};
  for (const r of verdicts) {
    for (const s of new Set(r.sourceIds)) {
      const e = (bySource[s] ??= { injections: 0, used: 0 });
      e.injections++;
      if (r.used) e.used++;
    }
  }
  const explicit = verdicts.filter((r) => r.how === "explicit").length;
  const packets = {
    bytes: records.reduce((a, r) => a + (typeof r.injectionBytes === "number" ? r.injectionBytes : 0), 0),
    counted: records.filter((r) => typeof r.injectionBytes === "number").length,
    // Every handed injection is the coverage denominator, `reset` rows included — a sized reset
    // must not hide an older sizeless record behind a "full coverage" line.
    total: records.length,
  };
  const connectors = connectorCalls(traces, syncRuns);
  return {
    events: report.events,
    sessionIds: report.sessionIds,
    added: report.spoke,
    kinds,
    sources,
    asks,
    used: {
      // Inference reads the agent's own messages and tool calls; with none reported and no feedback, use is unknown.
      measured: explicit > 0 || agentEvents > 0,
      injections: verdicts.length,
      used: verdicts.filter((r) => r.used).length,
      explicit,
      bySource,
    },
    packets,
    silent: {
      events: Object.values(report.silentReasons).reduce((a, b) => a + b, 0),
      reasons: report.silentReasons,
      nothingToLookUp,
    },
    connectors,
    report,
  };
}

/** Connector calls in a log: the agent's reported tool calls, Eden's lookups' calls and its sync's. */
function connectorCalls(traces: Trace[], syncRuns: Map<string, { done: number; last: number }>): ConnectorCalls {
  let requests = 0;
  let agent = 0;
  let edenRequest = 0;
  for (const t of traces) {
    edenRequest += t.sourceCalls;
    // One trace per observed event, follow-ups aside (trace-report's rule): count events by their kind once.
    const followUp =
      t.decision === "verify" ||
      t.decision === "reader-late" ||
      t.decision === "check-late" ||
      t.decision === "reader-push" ||
      (t.decision === "skipped" && (t.reason === "sync poll behind" || t.reason === "cut search behind")) ||
      t.reason.startsWith("updated:") ||
      // The party check's finding on a tool call the agent also reported: the same call, traced twice (`checkAction`).
      t.reason.startsWith("action-");
    if (followUp) continue;
    if (t.event === "user_message") requests++;
    if (t.event === "tool_call") agent++;
  }
  const background = syncRuns.size > 0 ? [...syncRuns.values()].reduce((a, r) => a + r.done + r.last, 0) : null;
  return { requests, agent, edenRequest, edenBackground: background };
}

/** Connector calls per 1,000 requests: the agent's, Eden's at request time, and Eden's background (0 when unknown). */
export const callsPer1k = (c: ConnectorCalls) => {
  const per = (n: number) => (c.requests > 0 ? (1_000 * n) / c.requests : 0);
  return { agent: per(c.agent), edenRequest: per(c.edenRequest), edenBackground: per(c.edenBackground ?? 0) };
};

/** explain's sentence for a silent reason (D277): fixed words, no content. */
const silentWhy = (reason: string) =>
  explainTrace({
    sessionId: "",
    turn: 0,
    event: "",
    decision: "silent",
    reason,
    latencyMs: 0,
    sourceCalls: 0,
    modelCalls: 0,
    costUsd: 0,
    itemIds: [],
  });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : "-");
const sorted = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]);

/** The digest as Markdown, for a status page, a PR or a slide. */
export function formatDigest(d: Digest): string {
  if (d.report.traces === 0) return "No traces found: start the server with EDEN_TRACE=1 and pass its log.";
  const r = d.report;
  const out = ["# Eden: what it added", ""];
  const headline =
    `Eden added context after **${d.added} of ${d.events} events (${pct(d.added, d.events)})** ` +
    `over ${d.sessionIds} sessions, and stayed silent on the rest.`;
  out.push(headline);
  if (d.used.measured && d.used.injections > 0) {
    out.push(
      `The agent visibly used **${d.used.used} of ${d.used.injections} injections (${pct(d.used.used, d.used.injections)})**` +
        ` whose outcome is known (any item of an injection counts)${d.used.explicit ? ` (${d.used.explicit} reported by the integration)` : ""}.`,
    );
  } else {
    out.push(
      "Whether the agent used it is **not measured**: report the agent's own messages and tool calls to Eden " +
        "(`agent_message`, `tool_call` events) or send `feedback`.",
    );
  }
  out.push("", "## What kind of context", "");
  for (const [k, n] of sorted(d.kinds as Record<string, number>)) out.push(`- ${n} × ${KIND_WORDS[k as Kind]}`);
  if (d.asks.total > 0) {
    out.push(
      `- the agent asked ${plural(d.asks.total, "time")}; ${plural(d.asks.withItems, "answer")} held items ` +
        `(${pct(d.asks.withItems, d.asks.total)})`,
    );
  }
  const src = sorted(d.sources);
  if (src.length > 0) {
    out.push("", "## From which connectors (items handed over)", "");
    for (const [s, n] of src) {
      const u = d.used.bySource[s];
      const usedNote = d.used.measured && u ? `; used in ${u.used} of ${u.injections} injections` : "";
      out.push(`- ${s}: ${n}${usedNote}`);
    }
  }
  out.push("", "## When it stayed silent", "");
  out.push(`- ${plural(d.silent.nothingToLookUp, "event")} had nothing to look up (chatter, the agent's own turns)`);
  for (const [w, n] of sorted(d.silent.reasons).slice(0, 5)) out.push(`- ${n} × ${silentWhy(w)}`);
  out.push("", "## Cost and speed", "");
  for (const [k, p] of Object.entries(r.latencyMs)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 4)) {
    out.push(`- ${k}: p50 ${p.p50} ms, p95 ${p.p95} ms (n ${p.n}; Eden's time to decide, not the network)`);
  }
  out.push(
    `- ${r.sourceCallsPerEvent} connector calls and ${r.modelCallsPerEvent} model calls per event`,
    `- request-time model spend $${r.costUsd.toFixed(4)} ($${r.costUsdPer1kEvents.toFixed(4)} per 1,000 events); ` +
      "background cards and intent are billed by the model provider, not traced",
  );
  if (d.packets.counted > 0) {
    const tokens = Math.round(d.packets.bytes / 4);
    const per1k = r.events > 0 ? Math.round(tokens / (r.events / 1_000)) : 0;
    const partial =
      d.packets.counted < d.packets.total
        ? ` (${d.packets.counted} of ${d.packets.total} injections name a size — a log from before the field ships none)`
        : "";
    out.push(
      `- packet text handed to the agent: ~${tokens.toLocaleString()} tokens` +
        (per1k > 0 ? ` (${per1k.toLocaleString()} per 1,000 events)` : "") +
        ` — the agent's model re-reads a session's packets on every later request${partial}`,
    );
  }
  out.push("", "## Connector calls and their price", "");
  const c = callsPer1k(d.connectors);
  const bg =
    d.connectors.edenBackground === null
      ? "not in this log (no sync counter lines)."
      : `${c.edenBackground.toFixed(0)} (backfill and sweeps; a new user's backfill is one-time).`;
  // With no user request to spread them over (an ask-only MCP integration reports no `user_message`), a rate per
  // request is unknown, not zero: the calls are said as counts and every price is n/a (audit A11).
  const perRequest = d.connectors.requests > 0;
  out.push(
    perRequest
      ? `Per 1,000 user requests (${d.connectors.requests} in this log): the agent's own tool calls ` +
          `${c.agent.toFixed(0)} (every reported \`tool_call\`, an upper bound on its connector calls), Eden's at ` +
          `request time ${c.edenRequest.toFixed(0)}, Eden's background sync ${bg}`
      : "Per 1,000 user requests: n/a, no user requests in this log (an integration that only asks reports no " +
          `\`user_message\` events). In all: the agent's own tool calls ${d.connectors.agent}, Eden's at request ` +
          `time ${d.connectors.edenRequest}, Eden's background sync ` +
          `${d.connectors.edenBackground === null ? "not in this log" : d.connectors.edenBackground}.`,
  );
  const b = d.baseline ? callsPer1k(d.baseline) : null;
  if (b) {
    out.push(
      `Without Eden's context (baseline log, ${d.baseline!.requests} requests): the agent's own tool calls ` +
        `${b.agent.toFixed(0)} per 1,000 requests.`,
    );
  }
  out.push(
    "",
    `| Plan ($ per 1,000 calls) | ${b ? "Without Eden | " : ""}With Eden, request time | With Eden, all calls |`,
    `|---|${b ? "---|" : ""}---|---|`,
  );
  for (const [plan, price] of Object.entries(CONNECTOR_PLANS)) {
    const usd = (calls: number) => `$${((calls * price) / 1_000).toFixed(2)}`;
    const request = perRequest ? usd(c.agent + c.edenRequest) : "n/a";
    // Unknown background is n/a, not the request-time figure again (which would read as no background calls).
    const all =
      !perRequest || d.connectors.edenBackground === null ? "n/a" : usd(c.agent + c.edenRequest + c.edenBackground);
    const without = b ? `${d.baseline!.requests > 0 ? usd(b.agent) : "n/a"} | ` : "";
    out.push(`| ${plan} (${price}) | ${without}${request} | ${all} |`);
  }
  out.push(
    "",
    "_$ per 1,000 user requests. Without a `--baseline` log (the proxy's shadow mode, or the agent before Eden) " +
      "there is no without-Eden column: one log cannot say what the agent would have called without Eden._",
  );
  out.push("", "_Counts and connector ids only: the log holds no request or item text (D56)._");
  return out.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const b = args.indexOf("--baseline");
  const baselineFile = b >= 0 ? args[b + 1] : undefined;
  if (b >= 0 && !baselineFile) {
    console.error("digest: --baseline needs a log file");
    process.exit(2);
  }
  const files = args.filter((a, i) => a !== "--json" && (b < 0 || (i !== b && i !== b + 1)));
  const bad = files.find((f) => f.startsWith("--"));
  if (bad) {
    console.error(`digest: unknown flag ${bad} (usage: bun run digest [log ...] [--baseline LOG] [--json])`);
    process.exit(2);
  }
  let text = "";
  let baseline = "";
  try {
    text =
      files.length > 0 ? (await Promise.all(files.map((f) => Bun.file(f).text()))).join("\n") : await Bun.stdin.text();
    if (baselineFile) baseline = await Bun.file(baselineFile).text();
  } catch (e) {
    console.error(`digest: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const d = digest(text.split("\n"));
  if (baselineFile) d.baseline = digest(baseline.split("\n")).connectors;
  console.log(json ? JSON.stringify(d, null, 2) : formatDigest(d));
}
