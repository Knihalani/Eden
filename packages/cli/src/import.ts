import { detectAndParse } from "@eden/core";
import { protocolHeaders, redact, type StretchTrace } from "@eden/ir";
import { loadCompileTraces } from "./compile";
import { readConfig, resolveApiKey, wrapBase } from "./home";

export const IMPORT_USAGE = `eden import --traces <dir|glob>
eden import --file <export>`;

export function importHelp(): string {
  return `eden import — send traces to wrap

  eden import --traces <dir|glob>     StretchTrace JSON (same files as compile)
  eden import --file <export>         LangSmith runs, OpenTelemetry spans, or JSONL

Posts to wrap POST /v1/traces. Wrap may compile. Does not Approve.
Human Approve is the On switch. Wrap down: one sentence, no stack dump.
Empty traces: nothing to import, exit 0.
When wrap minted a candidate, Next is eden approve (read the verdict). It does not ship.
`;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;

const WRAP_DOWN = "import: wrap is down · start eden wrap";

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function redactTraces(traces: StretchTrace[]): StretchTrace[] {
  return traces.map((t) => ({
    ...t,
    events: (t.events ?? []).map((e) => ({
      ...e,
      ...(e.args !== undefined ? { args: redact(e.args) as Record<string, unknown> } : {}),
      ...(e.result !== undefined ? { result: redact(e.result) } : {}),
    })),
  }));
}

function importedLetter(accepted: number, total: number, candidateCount: number): string {
  const lines = [`Imported ${accepted}/${total} traces. Does not Approve.`];
  if (candidateCount > 0) {
    const n = candidateCount === 1 ? "a candidate" : `${candidateCount} candidates`;
    lines.push(`Wrap minted ${n}. Read the verdict — it does not ship:`);
    lines.push("  eden approve");
    return lines.join("\n");
  }
  lines.push("Next:", "  eden explain");
  return lines.join("\n");
}

async function listCandidates(
  args: string[],
  opts?: { fetch?: typeof fetch },
): Promise<number> {
  let base: string;
  let key: string;
  try {
    const cfg = readConfig();
    base = wrapBase(cfg);
    key = resolveApiKey(args);
  } catch {
    return 0;
  }
  const fetchFn = opts?.fetch ?? fetch;
  try {
    const res = await fetchFn(`${base}/v1/candidates`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return 0;
    const body = (await res.json().catch(() => ({}))) as { candidates?: unknown[] };
    return Array.isArray(body.candidates) ? body.candidates.length : 0;
  } catch {
    return 0;
  }
}

async function postTraces(
  traces: StretchTrace[],
  args: string[],
  opts?: { fetch?: typeof fetch },
): Promise<{ ok: true; accepted: number } | { ok: false; code: number; sentence: string }> {
  let base: string;
  let key: string;
  try {
    const cfg = readConfig();
    base = wrapBase(cfg);
    key = resolveApiKey(args);
  } catch (e) {
    return { ok: false, code: 1, sentence: e instanceof Error ? e.message : String(e) };
  }
  const fetchFn = opts?.fetch ?? fetch;
  let accepted = 0;
  for (let i = 0; i < traces.length; i += 50) {
    const batch = traces.slice(i, i + 50);
    try {
      const res = await fetchFn(`${base}/v1/traces`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", ...protocolHeaders() },
        body: JSON.stringify({ traces: batch }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        return { ok: false, code: 1, sentence: `import: HTTP ${res.status}` };
      }
      const body = (await res.json().catch(() => ({}))) as { accepted?: number };
      accepted += body.accepted ?? 0;
    } catch {
      return { ok: false, code: 1, sentence: WRAP_DOWN };
    }
  }
  return { ok: true, accepted };
}

async function importStretchTraces(
  spec: string,
  args: string[],
  opts?: { fetch?: typeof fetch },
): Promise<number> {
  let traces: StretchTrace[] | "empty";
  try {
    traces = await loadCompileTraces(spec);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg.replace(/^eden compile:/, "eden import:"));
    return 1;
  }
  if (traces === "empty") {
    console.error("Nothing to import.");
    return 0;
  }
  const posted = await postTraces(redactTraces(traces), args, opts);
  if (!posted.ok) {
    console.error(posted.sentence);
    return posted.code;
  }
  const n = await listCandidates(args, opts);
  console.log(importedLetter(posted.accepted, traces.length, n));
  return 0;
}

async function importFile(
  filePath: string,
  args: string[],
  opts?: { fetch?: typeof fetch },
): Promise<number> {
  const { statSync, readFileSync } = await import("node:fs");
  try {
    const size = statSync(filePath).size;
    if (size > MAX_FILE_BYTES) {
      console.error(
        `${filePath} is ${(size / 1e6).toFixed(0)}MB — over the ${MAX_FILE_BYTES / 1e6}MB import limit. Split the export and import in parts.`,
      );
      return 1;
    }
  } catch {
    console.error(`Cannot read ${filePath}`);
    return 1;
  }
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    console.error(`Cannot read ${filePath}`);
    return 1;
  }

  const detected = detectAndParse(content);
  if (!detected || detected.traces.size === 0) {
    console.error("Unrecognized trace format, or no tool calls found. Expected: LangSmith runs, OTel spans, or generic JSONL.");
    return 1;
  }
  const { format, traces: traceMap } = detected;

  let totalEvents = 0;
  const traces: StretchTrace[] = [...traceMap.entries()].map(([tid, events], j) => {
    const cleanEvents = events.map((e) => ({
      ...e,
      ...(e.args !== undefined ? { args: redact(e.args) as Record<string, unknown> } : {}),
      ...(e.result !== undefined ? { result: redact(e.result) } : {}),
    }));
    totalEvents += cleanEvents.length;
    return {
      id: `${format}-imp-${j}-${tid.slice(0, 12)}`.replace(/[^\w.-]/g, "_"),
      events: cleanEvents,
      input: {},
      output: null,
      llmCalls: cleanEvents.length * 2,
      duration_ms: cleanEvents.length * 500,
      cost_cents: cleanEvents.length * 2,
      complete: true,
      metrics_estimated: true as const,
    };
  });
  const totalTraces = traces.length;
  console.log(`Detected ${format}: ${totalTraces} traces, ${totalEvents} tool calls (metrics estimated from event counts)`);

  const posted = await postTraces(traces, args, opts);
  if (!posted.ok) {
    console.error(posted.sentence);
    return posted.code;
  }
  const n = await listCandidates(args, opts);
  console.log(importedLetter(posted.accepted, totalTraces, n));
  return 0;
}

export async function importTraces(
  args: string[],
  opts?: { fetch?: typeof fetch },
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(importHelp());
    return 0;
  }

  const tracesFlag = args.includes("--traces");
  const fileFlag = args.includes("--file");
  const tracesSpec = arg(args, "--traces");
  const filePath = arg(args, "--file") ?? (!tracesFlag && !fileFlag ? args.find((a) => !a.startsWith("-")) : undefined);

  if (tracesFlag && fileFlag) {
    console.error("eden import: use --traces or --file, not both");
    return 2;
  }
  if (tracesFlag && !tracesSpec) {
    console.error("eden import: --traces is required");
    return 2;
  }
  if (tracesSpec) return importStretchTraces(tracesSpec, args, opts);
  if (filePath) return importFile(filePath, args, opts);

  console.error(IMPORT_USAGE);
  return 1;
}
