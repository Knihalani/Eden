import type { Binding, Step } from "../lib/types";

export const NW = 196;
export const NH = 104;
export const GAP_X = 56;
export const GAP_Y = 32;
export const PAD = 40;

export function bindText(b: Binding | undefined): string {
  if (!b) return "";
  if (b.kind === "literal") return JSON.stringify(b.value);
  if (b.kind === "input") return `in.${b.path}`;
  if (b.kind === "from") return `${b.step}.${b.path}`;
  return `${b.fn}(${bindText(b.of)})`;
}

function fromSteps(b: Binding | undefined, acc: string[] = []): string[] {
  if (!b) return acc;
  if (b.kind === "from") acc.push(b.step);
  if (b.kind === "transform") fromSteps(b.of, acc);
  return acc;
}

export function depsOf(s: Step): string[] {
  if (s.kind === "tool") return Object.values(s.args).flatMap((b) => fromSteps(b));
  if (s.kind === "island") return fromSteps(s.input);
  if (s.kind === "loop") return fromSteps(s.over);
  return [];
}

export function kindLabel(kind: Step["kind"]): string {
  if (kind === "tool") return "Tool";
  if (kind === "island") return "Model";
  if (kind === "loop") return "Loop";
  return "Check";
}

export function kindHint(kind: Step["kind"]): string {
  if (kind === "tool") return "Calls this tool with the arguments below.";
  if (kind === "island") return "Hands this step to a model. It is not compiled.";
  if (kind === "loop") return "Repeats the inner steps for each item.";
  return "Stops or falls back if this check fails.";
}

export function labelOf(s: Step): string {
  if (s.kind === "tool") return s.tool;
  if (s.kind === "island") return "model step";
  if (s.kind === "loop") return `loop ${s.item}`;
  return "check";
}

export function detailOf(s: Step): string {
  if (s.kind === "tool") {
    const keys = Object.keys(s.args);
    return keys.length ? keys.map((k) => `${k}: ${bindText(s.args[k])}`).join(" · ") : "no args";
  }
  if (s.kind === "island") return s.system.slice(0, 72);
  if (s.kind === "loop") return `over ${bindText(s.over)}`;
  return `${s.expr} → ${s.onFail === "deopt" ? "fall back" : "stop"}`;
}

export function bindingsOf(s: Step): Array<{ key: string; value: string }> {
  if (s.kind === "tool") return Object.entries(s.args).map(([key, b]) => ({ key, value: bindText(b) }));
  if (s.kind === "island") return [{ key: "input", value: bindText(s.input) }];
  if (s.kind === "loop") return [{ key: "over", value: bindText(s.over) }];
  return [{ key: "when", value: s.expr }];
}

export function topLevel(steps: Step[]): Step[] {
  const nested = new Set(steps.flatMap((s) => (s.kind === "loop" ? s.body : [])));
  return steps.filter((s) => !nested.has(s.id));
}

export type NodePos = { id: string; x: number; y: number; col: number; row: number };

export function incomingOf(laid: Step[]): Map<string, string[]> {
  const ids = new Set(laid.map((s) => s.id));
  const index = new Map(laid.map((s, i) => [s.id, i]));
  const incoming = new Map<string, string[]>();
  for (const s of laid) {
    const deps = [...new Set(depsOf(s).filter((d) => ids.has(d) && d !== s.id))];
    if (!deps.length && s.kind === "assert") {
      const i = index.get(s.id) ?? 0;
      const prev = laid[i - 1];
      if (prev) deps.push(prev.id);
    }
    incoming.set(s.id, deps);
  }
  const anyData = laid.some((s) => (incoming.get(s.id) ?? []).length > 0);
  if (!anyData && laid.length > 1) {
    for (let i = 1; i < laid.length; i++) incoming.set(laid[i]!.id, [laid[i - 1]!.id]);
  }
  return incoming;
}

export function layoutDag(steps: Step[]): { nodes: NodePos[]; width: number; height: number } {
  const laid = topLevel(steps);
  if (!laid.length) return { nodes: [], width: PAD * 2 + NW, height: PAD * 2 + NH };

  const incoming = incomingOf(laid);
  const col = new Map<string, number>();
  const visiting = new Set<string>();

  const rank = (id: string): number => {
    const hit = col.get(id);
    if (hit != null) return hit;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = incoming.get(id) ?? [];
    const r = deps.length ? 1 + Math.max(...deps.map(rank)) : 0;
    visiting.delete(id);
    col.set(id, r);
    return r;
  };
  for (const s of laid) rank(s.id);

  const byCol = new Map<number, string[]>();
  for (const s of laid) {
    const c = col.get(s.id) ?? 0;
    const list = byCol.get(c) ?? [];
    list.push(s.id);
    byCol.set(c, list);
  }

  const index = new Map(laid.map((s, i) => [s.id, i]));
  const outgoing = new Map<string, string[]>();
  for (const [to, froms] of incoming) {
    for (const from of froms) {
      const list = outgoing.get(from) ?? [];
      list.push(to);
      outgoing.set(from, list);
    }
  }
  const row = new Map<string, number>();
  const maxCol = Math.max(0, ...col.values());
  const bary = (rel: Map<string, string[]>, id: string) => {
    const ns = (rel.get(id) ?? []).map((x) => row.get(x)).filter((n): n is number => n != null);
    if (!ns.length) return index.get(id) ?? 0;
    return ns.reduce((a, b) => a + b, 0) / ns.length;
  };
  const assign = (c: number, rel: Map<string, string[]>) => {
    const nodes = byCol.get(c) ?? [];
    nodes.sort((a, b) => bary(rel, a) - bary(rel, b) || (index.get(a) ?? 0) - (index.get(b) ?? 0));
    nodes.forEach((id, i) => row.set(id, i));
  };
  for (let c = 0; c <= maxCol; c++) assign(c, incoming);
  for (let pass = 0; pass < 3; pass++) {
    for (let c = 0; c <= maxCol; c++) assign(c, incoming);
    for (let c = maxCol; c >= 0; c--) assign(c, outgoing);
  }

  const maxRow = Math.max(0, ...row.values());
  const contentH = (maxRow + 1) * (NH + GAP_Y) - GAP_Y;
  const height = Math.max(contentH + PAD * 2, 320);
  const extraY = Math.max(0, (height - contentH - PAD * 2) / 2);
  const width = (maxCol + 1) * (NW + GAP_X) - GAP_X + PAD * 2;

  const nodes = laid.map((s) => {
    const c = col.get(s.id) ?? 0;
    const r = row.get(s.id) ?? 0;
    return {
      id: s.id,
      col: c,
      row: r,
      x: PAD + c * (NW + GAP_X),
      y: PAD + extraY + r * (NH + GAP_Y),
    };
  });

  return { nodes, width, height };
}

export function edgesOf(steps: Step[]): Array<{ from: string; to: string }> {
  const laid = topLevel(steps);
  const incoming = incomingOf(laid);
  const edges: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const [to, froms] of incoming) {
    for (const from of froms) {
      const k = `${from}>${to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ from, to });
    }
  }
  return edges;
}

export function neighbor(
  nodes: NodePos[],
  id: string,
  dir: "left" | "right" | "up" | "down",
  edges: Array<{ from: string; to: string }> = [],
): string | null {
  const cur = nodes.find((n) => n.id === id);
  if (!cur) return nodes[0]?.id ?? null;
  if (dir === "up" || dir === "down") {
    const hit = nodes.find((n) => n.col === cur.col && n.row === cur.row + (dir === "down" ? 1 : -1));
    return hit?.id ?? null;
  }
  const linked =
    dir === "right"
      ? edges.filter((e) => e.from === id).map((e) => e.to)
      : edges.filter((e) => e.to === id).map((e) => e.from);
  const linkedNodes = linked.map((x) => nodes.find((n) => n.id === x)).filter((n): n is NodePos => Boolean(n));
  if (linkedNodes.length) {
    return linkedNodes.reduce((best, n) => (Math.abs(n.row - cur.row) < Math.abs(best.row - cur.row) ? n : best)).id;
  }
  const pool = nodes.filter((n) => n.col === cur.col + (dir === "right" ? 1 : -1));
  if (!pool.length) return null;
  return pool.reduce((best, n) => (Math.abs(n.row - cur.row) < Math.abs(best.row - cur.row) ? n : best)).id;
}

export function verdictLabel(v: string): string {
  if (v === "PASS") return "Ready";
  if (v === "pending") return "Checking";
  if (v === "FAIL") return "Failed";
  if (v === "INCONCLUSIVE") return "Unclear";
  if (v === "live") return "Live";
  if (v === "paused") return "Paused";
  if (v === "rolled_back") return "Rolled back";
  if (v === "preview") return "Preview";
  return v;
}
