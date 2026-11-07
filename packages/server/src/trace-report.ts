#!/usr/bin/env bun
/**
 * `bun run trace-report [log ...]` (D279): an integrator's self-check on their own traffic. Reads a server's log
 * written with `EDEN_TRACE=1` (one JSON trace per decision; other lines are skipped) from the files given or stdin,
 * and prints what Eden did and cost there: how often it spoke or stayed silent, its time per decision (p50/p95/p99),
 * its source calls and model calls per event, and the request-time model spend. Content-free, as the traces are
 * (D56). With `--json` it prints the summary as JSON.
 *
 * Not covered, by design: the background roles (implication cards and the intent index, D59, D87) spend outside any
 * request and leave no trace; their cost is in the model provider's bill, under `EDEN_MODEL_USD_PER_TENANT_DAY`.
 * `latencyMs` is Eden's time to its decision, not the network or the client's wait.
 */
import type { Trace } from "@eden/engine";

const SPOKE = new Set(["fast", "sources", "model", "answer", "reader-push"]);

export interface Percentiles {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface TraceReport {
  traces: number;
  /** Distinct session ids: traces carry no tenant or user, so two users' "s1" count once. */
  sessionIds: number;
  /** Events the engine saw (every trace but its own follow-ups: "verify", "reader-late", a sync poll's "skipped"). */
  events: number;
  decisions: Record<string, number>;
  /**
   * Events after which Eden handed the agent items (a packet, candidates or an answer with citations), each once, by
   * session id and turn: traces carry no user, so two users sharing a session id and a turn count once.
   */
  spoke: number;
  /** Lookups that ended with nothing (`silent`), with their reasons. */
  silentReasons: Record<string, number>;
  latencyMs: Record<string, Percentiles>;
  sourceCallsPerEvent: number;
  modelCalls: number;
  modelCallsPerEvent: number;
  costUsd: number;
  costUsdPer1kEvents: number;
}

function isTrace(v: unknown): v is Trace {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.decision === "string" &&
    typeof t.sessionId === "string" &&
    typeof t.reason === "string" &&
    typeof t.latencyMs === "number" &&
    Array.isArray(t.itemIds)
  );
}

function percentiles(xs: number[]): Percentiles {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0;
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s.at(-1) ?? 0 };
}

const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

/** Summarises trace lines; lines that are not a trace (startup lines, shadow records, junk) are skipped. */
export function traceReport(lines: Iterable<string>): TraceReport {
  const traces: Trace[] = [];
  for (const line of lines) {
    const at = line.indexOf("{");
    if (at < 0) continue;
    try {
      const v: unknown = JSON.parse(line.slice(at));
      if (isTrace(v)) traces.push(v);
    } catch {
      // Not a trace line.
    }
  }
  const decisions: Record<string, number> = {};
  const silentReasons: Record<string, number> = {};
  const latencies = new Map<string, number[]>();
  // An event is (session, turn): its own decision and its push's follow-up are one event that spoke once.
  const spokeAt = new Set<string>();
  let sourceCalls = 0;
  let modelCalls = 0;
  let costUsd = 0;
  let events = 0;
  const sessions = new Set<string>();
  for (const t of traces) {
    sessions.add(t.sessionId);
    decisions[t.decision] = (decisions[t.decision] ?? 0) + 1;
    const followUp =
      t.decision === "verify" ||
      t.decision === "reader-late" ||
      t.decision === "reader-push" ||
      (t.decision === "skipped" && t.reason === "sync poll behind") ||
      // An update packet (a source changed items already shown) follows a source notice, not an agent event.
      t.reason.startsWith("updated:");
    if (!followUp) events++;
    // An ask moves no turn (an ask-only session stays at turn 0), so each ask is its own event: keyed by (session,
    // turn) every ask of a turn read as one that spoke (audit A11). A push keys to its request's user message.
    if (SPOKE.has(t.decision) && t.itemIds.length > 0 && !t.reason.startsWith("updated:"))
      spokeAt.add(t.event === "ask" ? `ask#${events}` : `${t.sessionId}#${t.turn}#${t.event}`);
    if (t.decision === "silent") silentReasons[t.reason] = (silentReasons[t.reason] ?? 0) + 1;
    if (t.decision !== "skipped") {
      const xs = latencies.get(t.decision) ?? [];
      xs.push(t.latencyMs);
      latencies.set(t.decision, xs);
    }
    sourceCalls += t.sourceCalls || 0;
    modelCalls += t.modelCalls || 0;
    costUsd += t.costUsd || 0;
  }
  const per = (x: number) => (events > 0 ? x / events : 0);
  return {
    traces: traces.length,
    sessionIds: sessions.size,
    events,
    decisions,
    spoke: spokeAt.size,
    silentReasons,
    latencyMs: Object.fromEntries([...latencies].map(([d, xs]) => [d, percentiles(xs)])),
    sourceCallsPerEvent: round(per(sourceCalls), 3),
    modelCalls,
    modelCallsPerEvent: round(per(modelCalls), 4),
    costUsd: round(costUsd),
    costUsdPer1kEvents: round(per(costUsd) * 1_000),
  };
}

export function formatReport(r: TraceReport): string {
  if (r.traces === 0) return "no traces found: start the server with EDEN_TRACE=1 and pass its log";
  const pct = (n: number, of: number) => (of > 0 ? `${((100 * n) / of).toFixed(1)}%` : "-");
  const lines = [
    `${r.traces} traces, ${r.events} events, ${r.sessionIds} session ids`,
    `spoke (items handed to the agent): ${r.spoke} (${pct(r.spoke, r.events)} of events)`,
    `decisions: ${Object.entries(r.decisions)
      .sort((a, b) => b[1] - a[1])
      .map(([d, n]) => `${d} ${n}`)
      .join(", ")}`,
  ];
  const silent = Object.entries(r.silentReasons).sort((a, b) => b[1] - a[1]);
  if (silent.length > 0) lines.push(`silent because: ${silent.map(([w, n]) => `${w} ${n}`).join(", ")}`);
  lines.push("Eden's time to a decision (ms; not the network or the client's wait):");
  for (const [d, p] of Object.entries(r.latencyMs).sort((a, b) => b[1].n - a[1].n)) {
    lines.push(
      `  ${d.padEnd(12)} n ${String(p.n).padStart(6)}  p50 ${p.p50}  p95 ${p.p95}  p99 ${p.p99}  max ${p.max}`,
    );
  }
  lines.push(
    `source calls per event ${r.sourceCallsPerEvent}; model calls per event ${r.modelCallsPerEvent}` +
      ` (${r.modelCalls} in all)`,
    `request-time model spend $${r.costUsd} ($${r.costUsdPer1kEvents} per 1,000 events);` +
      " background cards and intent are not traced (see the provider's bill)",
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const files = args.filter((a) => a !== "--json");
  let text = "";
  try {
    text =
      files.length > 0 ? (await Promise.all(files.map((f) => Bun.file(f).text()))).join("\n") : await Bun.stdin.text();
  } catch (e) {
    console.error(`trace-report: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const report = traceReport(text.split("\n"));
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
}
