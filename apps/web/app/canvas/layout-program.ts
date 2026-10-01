import {
  billedTokens,
  reconcileTokenClasses,
  TOKEN_CLASSES,
  tokenClassKey,
  type TokenClass,
  type TokenClasses,
} from "@eden/ir";
import type { Binding, Step, StretchProgram } from "@eden/ir/types";
import { isMutating } from "@eden/ir/names";
import { providerCacheHitLine } from "@eden/measure";

export const NODE_W = 184;
export const NODE_H = 72;
export const COL_GAP = 104;
export const ROW_GAP = 64;

export type GraphNode = {
  id: string;
  kind: Step["kind"];
  label: string;
  tool?: string;
  write: boolean;
  tokenClass?: TokenClass;
  col: number;
  row: number;
  x: number;
  y: number;
};

export type GraphEdge = {
  from: string;
  to: string;
  field: string;
  path: string;
};

export type GraphLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
};

function bindingDeps(b: Binding): string[] {
  if (b.kind === "from") return [b.step];
  if (b.kind === "transform") return bindingDeps(b.of);
  return [];
}

export function stepDeps(step: Step, program?: StretchProgram): string[] {
  const bind =
    step.kind === "tool"
      ? Object.values(step.args).flatMap(bindingDeps)
      : step.kind === "island"
        ? bindingDeps(step.input)
        : step.kind === "loop"
          ? bindingDeps(step.over)
          : [];
  if (!program) return bind;
  return [...new Set([...bind, ...branchArmDeps(step, program)])];
}

/** Arm steps hang off the gate, then run in order down each arm. */
function branchArmDeps(step: Step, program: StretchProgram): string[] {
  for (const s of program.steps) {
    if (s.kind !== "branch") continue;
    const thenI = s.then.indexOf(step.id);
    if (thenI === 0) return [s.id];
    if (thenI > 0) return [s.id, s.then[thenI - 1]!];
    const els = s.else ?? [];
    const elseI = els.indexOf(step.id);
    if (elseI === 0) return [s.id];
    if (elseI > 0) return [s.id, els[elseI - 1]!];
  }
  return [];
}

function fromWires(step: Step): Array<{ from: string; field: string; path: string }> {
  const out: Array<{ from: string; field: string; path: string }> = [];
  const walk = (b: Binding, field: string) => {
    if (b.kind === "from") out.push({ from: b.step, field, path: b.path });
    if (b.kind === "transform") walk(b.of, field);
  };
  if (step.kind === "tool") {
    for (const [k, b] of Object.entries(step.args)) walk(b, k);
  } else if (step.kind === "island") walk(step.input, "input");
  else if (step.kind === "loop") walk(step.over, "over");
  return out;
}

function branchWires(step: Step): GraphEdge[] {
  if (step.kind !== "branch") return [];
  const edges: GraphEdge[] = [];
  const thenHead = step.then[0];
  if (thenHead) edges.push({ from: step.id, to: thenHead, field: "then", path: "" });
  const elseHead = (step.else ?? [])[0];
  if (elseHead) edges.push({ from: step.id, to: elseHead, field: "else", path: "" });
  for (let i = 1; i < step.then.length; i++) {
    edges.push({ from: step.then[i - 1]!, to: step.then[i]!, field: "then", path: "" });
  }
  const els = step.else ?? [];
  for (let i = 1; i < els.length; i++) {
    edges.push({ from: els[i - 1]!, to: els[i]!, field: "else", path: "" });
  }
  return edges;
}

/** Prefix → gate on the witnessed predicate. Not a `from` binding. */
function gateWires(step: Step, method: Step[]): GraphEdge[] {
  if (step.kind !== "branch") return [];
  return prevMethodDep(step, method).map((from) => ({
    from,
    to: step.id,
    field: "expr",
    path: step.expr,
  }));
}

/** Select-panel kind line. Branch names the witnessed predicate. */
export function stepAccessLine(step: Step): string {
  if (step.kind === "island") return "Model call. Auth declared on wrap — not stored here.";
  if (step.kind === "loop") return "Loop. Body stays inside this step.";
  if (step.kind === "assert") return "Check. Pinned — cannot drop.";
  if (step.kind === "branch") {
    return step.expr
      ? `Branch. ${step.expr}. Both arms witnessed before shipping.`
      : "Branch. Both arms witnessed before shipping.";
  }
  if (step.kind !== "tool") return "Model step. Auth declared on wrap — not stored here.";
  if (isMutating(step.tool)) return "Write. Auth declared on wrap — not stored here.";
  return "Read. Auth declared on wrap — not stored here.";
}

/** Witnessed control fields — shown, not rewired as `from` bindings. */
export function witnessLines(step: Step): Array<{ field: string; text: string }> {
  if (step.kind === "branch" && step.expr) return [{ field: "expr", text: step.expr }];
  return [];
}

function labelOf(step: Step): string {
  if (step.kind === "tool") return step.tool;
  if (step.kind === "island") return "model";
  if (step.kind === "loop") return "loop";
  if (step.kind === "branch") return "branch";
  return "check";
}

function isWrite(step: Step): boolean {
  return step.kind === "tool" && step.readOnly !== true && isMutating(step.tool);
}

export type TokenClassCtx = {
  skipped?: string[];
  memoized?: boolean;
  /** Live remainder head that actually ran — not compiled, not frontier. */
  transparent?: boolean;
  /** True when this graph is a compiled program that already ran the tool steps. */
  compiledRan?: boolean;
};

/**
 * Honest mapping: skipped receipt names → steered-skip; island → compiled
 * (memoized only when the caller says the manifest/receipt is memoized);
 * transparent serving → transparent; tools the compiled program ran → compiled,
 * otherwise frontier; assert/loop/branch unlabeled.
 */
export function tokenClassForNode(
  step: { id: string; kind: Step["kind"]; tool?: string },
  ctx: TokenClassCtx = {},
): TokenClass | undefined {
  const skipped = new Set(ctx.skipped ?? []);
  if (skipped.has(step.id) || (step.tool && skipped.has(step.tool))) return "steered-skip";
  if (step.kind === "island") return ctx.memoized ? "memoized" : "compiled";
  if (step.kind === "tool") {
    if (ctx.transparent) return "transparent";
    return ctx.compiledRan ? "compiled" : "frontier";
  }
  return undefined;
}

/**
 * Five-class summing ledger. Same words as TOKEN_CLASSES. Cache is excluded
 * from the sum — 12.2 owns the "provider cache hit %" line.
 */
export function tokenClassLedgerLine(classes: TokenClasses): string {
  const parts = TOKEN_CLASSES.map((name) => `${name} ${classes[tokenClassKey(name)]}`);
  return `${parts.join(" · ")} = ${billedTokens(classes)}`;
}

/**
 * Ledger plus prompt+completion. If both are present and they disagree, say
 * mismatch — do not invent a share or hide either number.
 */
export function tokenClassLedgerReconcileLine(
  classes: TokenClasses,
  provider?: { prompt: number; completion: number },
): string {
  const line = tokenClassLedgerLine(classes);
  if (!provider) return line;
  const recon = reconcileTokenClasses(classes, provider);
  const withProvider = `${line} · prompt+completion ${recon.provider}`;
  return recon.ok ? withProvider : `${withProvider} · mismatch`;
}

/**
 * NodeDetail "provider cache hit %" line. Omit when unmeasured.
 * Not run-cache `cache_hits / cache_lookups` ("3 of 4 reads").
 */
export function nodeProviderCacheHitLine(
  rec?: {
    cached_tokens?: number;
    prompt_tokens?: number;
    cache_write_tokens?: number;
    cache_input_tokens?: number;
  } | null,
): string | null {
  if (!rec) return null;
  return providerCacheHitLine(rec.cached_tokens, rec.prompt_tokens, rec.cache_write_tokens, rec.cache_input_tokens);
}

function loopOwned(program: StretchProgram): Set<string> {
  const owned = new Set<string>();
  for (const s of program.steps) {
    if (s.kind === "loop") for (const id of s.body) owned.add(id);
  }
  return owned;
}

function branchOwned(program: StretchProgram): Set<string> {
  const owned = new Set<string>();
  for (const s of program.steps) {
    if (s.kind !== "branch") continue;
    for (const id of s.then) owned.add(id);
    for (const id of s.else ?? []) owned.add(id);
  }
  return owned;
}

/** Top-level method steps — loop bodies and branch arms stay nested, like the runtime. */
export function methodSteps(program: StretchProgram): Step[] {
  const owned = new Set([...loopOwned(program), ...branchOwned(program)]);
  return program.steps.filter((s) => !owned.has(s.id));
}

/**
 * Graph nodes: method spine plus branch arms (then/else as columns after the gate).
 * Loop bodies stay inside the loop node.
 */
export function graphSteps(program: StretchProgram): Step[] {
  const owned = loopOwned(program);
  return program.steps.filter((s) => !owned.has(s.id));
}

function prevMethodDep(step: Step, method: Step[]): string[] {
  if (step.kind !== "assert" && step.kind !== "branch") return [];
  const i = method.findIndex((x) => x.id === step.id);
  const prev = i > 0 ? method[i - 1] : undefined;
  return prev ? [prev.id] : [];
}

export function layoutProgram(program: StretchProgram, tokenCtx: TokenClassCtx = {}): GraphLayout {
  const method = methodSteps(program);
  const steps = graphSteps(program);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const ids = steps.map((s) => s.id);
  const deps = new Map<string, string[]>();
  for (const s of steps) {
    deps.set(s.id, [...new Set([...stepDeps(s, program).filter((id) => byId.has(id)), ...prevMethodDep(s, method)])]);
  }

  const col = new Map<string, number>();
  const pending = new Set(ids);
  let guard = ids.length + 2;
  while (pending.size && guard--) {
    const ready = [...pending].filter((id) => (deps.get(id) ?? []).every((p) => !pending.has(p)));
    if (!ready.length) {
      for (const id of pending) col.set(id, 0);
      break;
    }
    for (const id of ready) {
      const pred = deps.get(id) ?? [];
      col.set(id, pred.length ? Math.max(...pred.map((p) => col.get(p) ?? 0)) + 1 : 0);
      pending.delete(id);
    }
  }

  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const c = col.get(id) ?? 0;
    const list = columns.get(c) ?? [];
    list.push(id);
    columns.set(c, list);
  }

  const nodes: GraphNode[] = [];
  let maxCol = 0;
  let maxRow = 0;
  for (const [c, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    list.forEach((id, row) => {
      const step = byId.get(id)!;
      maxCol = Math.max(maxCol, c);
      maxRow = Math.max(maxRow, row);
      nodes.push({
        id,
        kind: step.kind,
        label: labelOf(step),
        tool: step.kind === "tool" ? step.tool : undefined,
        write: isWrite(step),
        tokenClass: tokenClassForNode(
          { id, kind: step.kind, tool: step.kind === "tool" ? step.tool : undefined },
          tokenCtx,
        ),
        col: c,
        row,
        x: c * (NODE_W + COL_GAP),
        y: row * (NODE_H + ROW_GAP),
      });
    });
  }

  const edges: GraphEdge[] = [];
  for (const s of steps) {
    for (const w of fromWires(s)) {
      if (!byId.has(w.from)) continue;
      edges.push({ from: w.from, to: s.id, field: w.field, path: w.path });
    }
    for (const w of gateWires(s, method)) {
      if (!byId.has(w.from) || !byId.has(w.to)) continue;
      edges.push(w);
    }
    for (const w of branchWires(s)) {
      if (!byId.has(w.from) || !byId.has(w.to)) continue;
      edges.push(w);
    }
  }

  return {
    nodes,
    edges,
    width: Math.max(NODE_W, (maxCol + 1) * (NODE_W + COL_GAP) - COL_GAP),
    height: Math.max(NODE_H, (maxRow + 1) * (NODE_H + ROW_GAP) - ROW_GAP),
  };
}

export function dependentsOf(program: StretchProgram, id: string): string[] {
  const method = methodSteps(program);
  return graphSteps(program)
    .filter((s) => stepDeps(s, program).includes(id) || prevMethodDep(s, method).includes(id))
    .map((s) => s.id);
}

export function strippedFromMethod(program: StretchProgram): string[] {
  const kept = new Set(program.steps.filter((s) => s.kind === "tool").map((s) => s.tool));
  const controlIds = new Set(program.steps.filter((s) => s.kind !== "tool").map((s) => s.id));
  return (program.sequence ?? []).filter((name) => !kept.has(name) && !controlIds.has(name));
}

export function bindingFaults(program: StretchProgram): Array<{ field: string; message: string }> {
  const known = new Set(program.steps.map((s) => s.id));
  const faults: Array<{ field: string; message: string }> = [];
  const walk = (b: Binding, field: string) => {
    if (b.kind === "from") {
      if (!b.step) faults.push({ field, message: "Missing step." });
      else if (!known.has(b.step)) faults.push({ field, message: `Unknown step ${b.step}.` });
    }
    if (b.kind === "transform") walk(b.of, field);
  };
  for (const s of program.steps) {
    if (s.kind === "tool") {
      for (const [k, b] of Object.entries(s.args)) walk(b, `${s.id}.${k}`);
    } else if (s.kind === "island") walk(s.input, `${s.id}.input`);
    else if (s.kind === "loop") walk(s.over, `${s.id}.over`);
  }
  walk(program.returns, "returns");
  return faults;
}
