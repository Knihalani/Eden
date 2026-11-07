#!/usr/bin/env bun
/**
 * `bun run digest [log ...] [--json]` (D293): "Eden caught this", a content-light report an integrator can show
 * stakeholders, over a server's `EDEN_TRACE=1` log (the files given, or stdin): how often Eden added context and what
 * kind, from which connectors, how often the agent then used it, how often it stayed silent and why, and its time
 * and request-time spend. Built only on what the log already holds, which is content-free (D56): decision traces
 * (`trace-report`'s input) and usage records (`{"usage": …}` lines, `onUsage`, D293). It prints counts, shares,
 * connector ids and percentiles; never an item id, a request or an item's text.
 *
 * "Used" is the engine's inference (D18: a later agent message or tool call repeats the injection's distinctive
 * terms) or the integration's explicit feedback (D13). It is coarse: it is per injection, so a packet of five
 * candidates counts as used when the agent repeats any one of them, and it misses use in other words. It is only
 * measured when the integration reports the agent's own messages or tool calls, or sends feedback: without either
 * the digest says "not measured" rather than 0%. Traces carry no clock, so the period is whatever log is given (a
 * day's, a week's).
 */
import { explainTrace, type Trace, type UsageRecord } from "@eden/engine";
import { traceReport, type TraceReport } from "./trace-report";

/** What kind of help a trace that spoke gave, in words a stakeholder reads. */
export type Kind = "conflict" | "candidates" | "match" | "cached" | "answer" | "update" | "judged" | "firewall";

const KIND_WORDS: Record<Kind, string> = {
  conflict: "a clash or a person/day match with the request (no model)",
  candidates: "items to check before an action (the request acts)",
  match: "a confident match from a source search",
  cached: "a confident match from the user's synced items",
  answer: "answers to the agent's own questions (ask_context)",
  update: "a newer version of something already shown",
  judged: "a match a model judged",
  firewall: "a finding on a tool call about to run",
};

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
  silent: { events: number; reasons: Record<string, number>; nothingToLookUp: number };
  report: TraceReport;
}

function isUsage(v: unknown): v is { usage: UsageRecord } {
  if (!v || typeof v !== "object") return false;
  const u = (v as { usage?: Record<string, unknown> }).usage;
  return !!u && typeof u.injectionId === "string" && typeof u.used === "boolean" && Array.isArray(u.sourceIds);
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
      return t.reason.startsWith("action-") ? "firewall" : "cached";
    case "sources":
      return t.reason.startsWith("grounded-") ? "conflict" : "match";
    default:
      return null;
  }
}

/** A connector id from an item id (`itemId`: `<sourceId>:<ref>`); the ref is never kept. */
const sourceOf = (itemId: string) => itemId.slice(0, Math.max(0, itemId.indexOf(":"))) || "unknown";

export function digest(lines: Iterable<string>): Digest {
  const all = [...lines];
  const report = traceReport(all);
  const kinds: Partial<Record<Kind, number>> = {};
  const sources: Record<string, number> = {};
  const asks = { total: 0, withItems: 0 };
  const usage = new Map<string, UsageRecord>();
  let agentEvents = 0;
  let nothingToLookUp = 0;
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
      usage.set(v.usage.injectionId, v.usage);
      continue;
    }
    const t = v as Trace;
    if (!t || typeof t.decision !== "string" || !Array.isArray(t.itemIds) || typeof t.reason !== "string") continue;
    if (t.event === "agent_message" || t.event === "tool_call") agentEvents++;
    if (t.decision === "skipped" && t.reason !== "sync poll behind") nothingToLookUp++;
    if (t.decision === "answer") {
      asks.total++;
      if (t.itemIds.length > 0) asks.withItems++;
    }
    const k = kindOf(t);
    if (!k) continue;
    kinds[k] = (kinds[k] ?? 0) + 1;
    for (const id of t.itemIds) sources[sourceOf(id)] = (sources[sourceOf(id)] ?? 0) + 1;
  }
  const records = [...usage.values()];
  const bySource: Digest["used"]["bySource"] = {};
  for (const r of records) {
    for (const s of new Set(r.sourceIds)) {
      const e = (bySource[s] ??= { injections: 0, used: 0 });
      e.injections++;
      if (r.used) e.used++;
    }
  }
  const explicit = records.filter((r) => r.how === "explicit").length;
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
      injections: records.length,
      used: records.filter((r) => r.used).length,
      explicit,
      bySource,
    },
    silent: {
      events: Object.values(report.silentReasons).reduce((a, b) => a + b, 0),
      reasons: report.silentReasons,
      nothingToLookUp,
    },
    report,
  };
}

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
  out.push("", "_Counts and connector ids only: the log holds no request or item text (D56)._");
  return out.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const files = args.filter((a) => a !== "--json");
  const bad = files.find((f) => f.startsWith("--"));
  if (bad) {
    console.error(`digest: unknown flag ${bad} (usage: bun run digest [log ...] [--json])`);
    process.exit(2);
  }
  let text = "";
  try {
    text =
      files.length > 0 ? (await Promise.all(files.map((f) => Bun.file(f).text()))).join("\n") : await Bun.stdin.text();
  } catch (e) {
    console.error(`digest: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const d = digest(text.split("\n"));
  console.log(json ? JSON.stringify(d, null, 2) : formatDigest(d));
}
