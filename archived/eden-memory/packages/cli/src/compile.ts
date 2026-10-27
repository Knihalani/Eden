import { existsSync } from "node:fs";
import type { Binding, Refusal, Step, StretchProgram, StretchTrace } from "@eden/ir";
import { refusalCodeOf } from "@eden/ir";
import { compileTraces } from "../../compile/src/index";
import { tracePaths } from "./bench";

export const USAGE = `eden compile — compile traces into programs

  eden compile --traces <dir|glob>          Letter (default)
  eden compile --traces <dir|glob> --json   Same facts as JSON

Prints program names, sequences (tool → tool), named refusals, and a
turns-saved estimate (naive event count vs 1 if compiled).
Names foreach, branch, poll, cursor, or offset pages when those steps are present.
Empty traces: nothing to compile, exit 0.
Unique work is 0 programs, not a win.
Does not Approve. Does not hit the network.`;

export function compileHelp(): string {
  return USAGE;
}

export const SHAPE_KINDS = ["loop", "branch", "poll", "island", "cursor", "offset"] as const;
export type CompileShapeKind = (typeof SHAPE_KINDS)[number];

export type CompileProgramFact = {
  name: string;
  sequence: string[];
  naiveEvents: number;
  compiledTurns: 1;
  turnsSaved: number;
  shape: CompileShapeKind[];
};

export type CompileRefusalFact = {
  /** Documented Refusal.code, or null — never an invented class. */
  code: string | null;
  sequence: string[];
  reason: string;
};

export type CompileReport = {
  programs: CompileProgramFact[];
  refusals: CompileRefusalFact[];
  turnsSaved: number;
  uniqueWork: boolean;
  shape: CompileShapeKind[];
};

const KNOWN_FLAGS = new Set(["--help", "-h", "--traces", "--json"]);

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function unknownArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--traces") {
      i += 1;
      continue;
    }
    if (KNOWN_FLAGS.has(a)) continue;
    return a;
  }
  return undefined;
}

function parseTrace(text: string, path: string): StretchTrace {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`eden compile: ${path} is not valid JSON (${(e as Error).message})`);
  }
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`eden compile: ${path} is not a trace object`);
  }
  const t = json as Record<string, unknown>;
  const need = (k: string, ok: boolean) => {
    if (!ok) throw new Error(`eden compile: ${path} has no usable "${k}" — not a StretchTrace`);
  };
  need("id", typeof t.id === "string");
  need("events", Array.isArray(t.events));
  for (const k of ["llmCalls", "duration_ms", "cost_cents"] as const) {
    need(k, typeof t[k] === "number" && Number.isFinite(t[k] as number));
  }
  return t as unknown as StretchTrace;
}

export async function loadCompileTraces(spec: string): Promise<StretchTrace[] | "empty"> {
  const globbed = spec.includes("*") || spec.includes("?");
  if (!globbed && !existsSync(spec)) return "empty";
  const paths = tracePaths(spec);
  if (!paths.length) return "empty";
  const traces: StretchTrace[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch {
      throw new Error(`eden compile: cannot read trace file ${path}`);
    }
    traces.push(parseTrace(text, path));
  }
  if (!traces.length) return "empty";
  return traces;
}

function programSequence(p: StretchProgram): string[] {
  if (Array.isArray(p.sequence) && p.sequence.length) return p.sequence.filter(Boolean);
  const names: string[] = [];
  for (const s of p.steps) {
    if (s.kind === "tool" && s.tool) names.push(s.tool);
  }
  return names;
}

/** LoopStep.until — poll, not foreach. Compiler may add it; we do not invent. */
function loopUntil(s: Step): unknown {
  if (s.kind !== "loop") return undefined;
  return (s as Step & { until?: unknown }).until;
}

function isPollLoop(s: Step): boolean {
  const until = loopUntil(s);
  return until != null && until !== false && until !== "";
}

function leafPath(b: Binding): string | undefined {
  if (b.kind === "from" || b.kind === "input") {
    const segs = (b.path ?? "")
      .split(".")
      .map((x) => x.trim())
      .filter(Boolean);
    return segs.at(-1);
  }
  if (b.kind === "transform") return leafPath(b.of);
  return undefined;
}

function firstLoopOver(p: StretchProgram): string | undefined {
  for (const s of p.steps) {
    if (s.kind !== "loop" || isPollLoop(s)) continue;
    return leafPath(s.over);
  }
  return undefined;
}

function firstBranchOn(p: StretchProgram): string | undefined {
  for (const s of p.steps) {
    if (s.kind !== "branch") continue;
    const m = s.expr.match(/^([A-Za-z_][\w.]*)\s*(==|!=|>=|<=|>|<)/);
    const field = m?.[1]?.split(".").filter(Boolean).at(-1);
    return field;
  }
  return undefined;
}

function isCursorLoop(s: Step, p: StretchProgram): boolean {
  if (!isPollLoop(s)) return false;
  const until = loopUntil(s);
  if (typeof until === "string" && /cursor|has_more|hasNextPage|nextCursor|endCursor/i.test(until)) return true;
  if (s.kind !== "loop") return false;
  for (const id of s.body) {
    const step = p.steps.find((x) => x.id === id);
    if (step?.kind !== "tool") continue;
    for (const b of Object.values(step.args)) {
      if (bindingHasCursorOr(b)) return true;
    }
  }
  return false;
}

function bindingHasCursorOr(b: Binding): boolean {
  if (b.kind === "from" && b.or && /cursor|next_page|endCursor/i.test(b.path)) return true;
  if (b.kind === "transform") return bindingHasCursorOr(b.of);
  return false;
}

function isOffsetLoop(s: Step, p: StretchProgram): boolean {
  if (!isPollLoop(s) || isCursorLoop(s, p)) return false;
  const until = loopUntil(s);
  if (typeof until === "string" && /page|totalPages|items\.length|offset/i.test(until)) return true;
  if (s.kind !== "loop") return false;
  for (const id of s.body) {
    const step = p.steps.find((x) => x.id === id);
    if (step?.kind !== "tool") continue;
    for (const b of Object.values(step.args)) {
      if (bindingIsAdd(b)) return true;
    }
  }
  return false;
}

function bindingIsAdd(b: Binding): boolean {
  if (b.kind === "transform" && b.fn === "add") return true;
  if (b.kind === "transform") return bindingIsAdd(b.of);
  return false;
}

function programShape(p: StretchProgram): CompileShapeKind[] {
  const seen = new Set<CompileShapeKind>();
  for (const s of p.steps) {
    if (s.kind === "island") seen.add("island");
    else if (s.kind === "branch") seen.add("branch");
    else if (s.kind === "loop") {
      if (isCursorLoop(s, p)) seen.add("cursor");
      else if (isOffsetLoop(s, p)) seen.add("offset");
      else seen.add(isPollLoop(s) ? "poll" : "loop");
    }
  }
  return SHAPE_KINDS.filter((k) => seen.has(k));
}

function mergeShapes(parts: CompileShapeKind[][]): CompileShapeKind[] {
  const seen = new Set<CompileShapeKind>();
  for (const part of parts) for (const k of part) seen.add(k);
  return SHAPE_KINDS.filter((k) => seen.has(k));
}

/** One letter line per present kind. Island is JSON-only. Do not dump IR. */
function shapeLetterLines(p: StretchProgram, shape: CompileShapeKind[]): string[] {
  const lines: string[] = [];
  for (const k of shape) {
    if (k === "loop") {
      const over = firstLoopOver(p);
      lines.push(over ? `foreach over ${over}` : "foreach");
    } else if (k === "branch") {
      const on = firstBranchOn(p);
      lines.push(on ? `branch on ${on}` : "branch");
    } else if (k === "poll") {
      lines.push("poll until ready");
    } else if (k === "cursor") {
      lines.push("cursor pages until next is empty");
    } else if (k === "offset") {
      lines.push("offset pages until the last page");
    }
  }
  return lines;
}

const letterExtra = new WeakMap<CompileProgramFact, string[]>();
const letterSequence = new WeakMap<CompileProgramFact, string[]>();

function nestedStepIds(p: StretchProgram): Set<string> {
  const nested = new Set<string>();
  const add = (ids?: string[]) => {
    if (!ids) return;
    for (const id of ids) nested.add(id);
  };
  for (const s of p.steps) {
    if (s.kind === "loop") add(s.body);
    else if (s.kind === "branch") {
      add(s.then);
      add(s.else);
      for (const c of s.cases ?? []) add(c.steps);
    }
  }
  return nested;
}

function loopPrefix(s: Step, p: StretchProgram): string {
  if (isCursorLoop(s, p)) return "cursor";
  if (isOffsetLoop(s, p)) return "offset";
  if (isPollLoop(s)) return "poll";
  return "foreach";
}

/** Compiled letter tokens from steps. JSON `sequence` is this list (same facts as the letter). */
function compiledLetterSequence(p: StretchProgram): string[] {
  const nested = nestedStepIds(p);
  const byId = new Map(p.steps.map((s) => [s.id, s]));
  const token = (s: Step): string => {
    if (s.kind === "tool" && s.tool) return s.tool;
    if (s.kind === "branch") return "branch";
    if (s.kind === "island") return "island";
    if (s.kind === "loop") {
      const inner = s.body
        .map((id) => byId.get(id))
        .filter((x): x is Step => x != null)
        .map(token)
        .filter(Boolean);
      const body = inner.join(", ");
      const prefix = loopPrefix(s, p);
      return body ? `${prefix} ${body}` : prefix;
    }
    return "";
  };
  const tokens: string[] = [];
  for (const s of p.steps) {
    if (nested.has(s.id)) continue;
    const t = token(s);
    if (t) tokens.push(t);
  }
  return tokens;
}

function programFact(p: StretchProgram): CompileProgramFact {
  const sequence = programSequence(p);
  const naiveEvents = sequence.length;
  const turnsSaved = Math.max(0, naiveEvents - 1);
  const shape = programShape(p);
  const compiled = compiledLetterSequence(p);
  const shown = compiled.length ? compiled : sequence;
  const fact: CompileProgramFact = {
    name: p.name,
    sequence: shown,
    naiveEvents,
    compiledTurns: 1,
    turnsSaved,
    shape,
  };
  const extra = shapeLetterLines(p, shape);
  if (extra.length) letterExtra.set(fact, extra);
  letterSequence.set(fact, shown);
  return fact;
}

function refusalFact(r: Refusal): CompileRefusalFact {
  const code = refusalCodeOf(r) ?? r.code ?? null;
  return {
    code,
    sequence: Array.isArray(r.sequence) ? r.sequence.filter(Boolean) : [],
    reason: r.reason,
  };
}

export function collectCompile(traces: StretchTrace[]): CompileReport {
  const mined = compileTraces(traces);
  const programs = mined.programs.map(programFact);
  const refusals = mined.refusals.map(refusalFact);
  const turnsSaved = programs.reduce((s, p) => s + p.turnsSaved, 0);
  return {
    programs,
    refusals,
    turnsSaved,
    uniqueWork: programs.length === 0 && refusals.length === 0,
    shape: mergeShapes(programs.map((p) => p.shape)),
  };
}

function seqLine(seq: string[]): string {
  return seq.length ? seq.join(" → ") : "(no sequence)";
}

function nextCommandLines(report: CompileReport, tracesSpec?: string): string[] {
  if (report.programs.length) {
    const lines = ["Next:"];
    if (tracesSpec) lines.push(`  eden import --traces ${tracesSpec}`);
    lines.push("  eden approve");
    lines.push("  read the verdict; cannot ship FAIL / INCONCLUSIVE");
    return lines;
  }
  return ["Next:", "  eden explain"];
}

export function formatCompile(report: CompileReport, tracesSpec?: string): string {
  const n = report.programs.length;
  const lines: string[] = [`eden compile — ${n} program${n === 1 ? "" : "s"}`, ""];

  if (report.uniqueWork) {
    lines.push("Unique work — nothing repeated, not a compile win.");
    lines.push("turns-saved estimate: 0 (nothing compiled)");
    lines.push("");
    lines.push("Refusals: none");
    lines.push("");
    lines.push(...nextCommandLines(report, tracesSpec));
    return lines.join("\n");
  }

  for (const p of report.programs) {
    lines.push(`  ${p.name}`);
    lines.push(`    ${seqLine(letterSequence.get(p) ?? p.sequence)}`);
    for (const extra of letterExtra.get(p) ?? []) lines.push(`    ${extra}`);
    lines.push(
      `    turns-saved estimate: ${p.naiveEvents} naive events → ${p.compiledTurns} compiled (${p.turnsSaved} saved)`,
    );
    lines.push("");
  }

  if (!report.programs.length) {
    lines.push("turns-saved estimate: 0 (nothing compiled)");
    lines.push("");
  }

  if (!report.refusals.length) {
    lines.push("Refusals: none");
  } else {
    lines.push("Refusals:");
    for (const r of report.refusals) {
      const name = r.code ?? "Refused";
      lines.push(`  ${name}`);
      lines.push(`    ${seqLine(r.sequence)}`);
      if (r.reason) lines.push(`    ${r.reason}`);
    }
  }
  lines.push("");
  lines.push(...nextCommandLines(report, tracesSpec));
  return lines.join("\n");
}

export function formatCompileJson(report: CompileReport): string {
  return JSON.stringify(
    {
      programs: report.programs,
      refusals: report.refusals,
      turnsSaved: report.turnsSaved,
      uniqueWork: report.uniqueWork,
      shape: report.shape,
    },
    null,
    2,
  );
}

export async function compileCli(args: string[] = []): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const unknown = unknownArg(args);
  if (unknown) {
    console.error(`eden compile: unknown flag ${unknown}`);
    return 2;
  }
  const spec = arg(args, "--traces");
  if (!spec) {
    console.error(USAGE);
    console.error("\neden compile: --traces is required");
    return 2;
  }
  try {
    const traces = await loadCompileTraces(spec);
    if (traces === "empty") {
      console.error("Nothing to compile.");
      return 0;
    }
    const report = collectCompile(traces);
    if (args.includes("--json")) console.log(formatCompileJson(report));
    else console.log(formatCompile(report, spec));
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
