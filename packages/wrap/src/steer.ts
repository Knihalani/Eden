import type { StretchProgram, ToolStep } from "@eden/ir";
import { inDistribution, mayServe, asRecord, getPath, interpolateSlots, setKey, PTC_CALLERS } from "@eden/ir";
import { parameterizeUrl, extractCommandUrls } from "../../core/src/urls";
import { parseNamedCli, familyId } from "../../core/src/named-cli";
import { commandShapeCached } from "../../core/src/shapes";

export type OpenAiToolCall = {
  id?: string;
  type?: string;
  function?: { name: string; arguments: string };
  name?: string;
  arguments?: unknown;
  matched_by?: "name" | "argshape";
};

function callArgs(c: OpenAiToolCall): Record<string, unknown> {
  if (c.function?.arguments) {
    try {
      return asRecord(JSON.parse(c.function.arguments));
    } catch {
      return {};
    }
  }
  return asRecord(c.arguments);
}

export function extractInput(program: StretchProgram, args: Record<string, unknown>): Record<string, unknown> {
  const props = asRecord((program.inputSchema as { properties?: unknown }).properties);
  const envKeys = Object.keys(program.contract.envelope?.inputs ?? {});
  const keys = [...new Set([...Object.keys(props), ...envKeys])];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in args) setKey(out, k, args[k]);
    else {
      const nested = k.includes(".") ? getPath(args, k) : undefined;
      if (nested !== undefined) setKey(out, k, nested);
    }
  }
  if (!Object.keys(out).length) {
    const aliases = ["id", "ticket_id", "ticketId", "issue", "number", "key"];
    const dest = keys[0] || "id";
    for (const a of aliases) {
      if (a in args) {
        setKey(out, dest, args[a]);
        break;
      }
    }
  }
  if (!Object.keys(out).length) return args;
  return out;
}

function urlShape(url: string): string | null {
  const templated = parameterizeUrl(url);
  const m = templated.match(/^(https?:\/\/)([^/?#]+)([^?#]*)/i);
  if (!m) return null;
  return `${m[2]!}${m[3] || "/"}`.replaceAll("{issue}", "{id}").replaceAll("{run_id}", "{id}");
}

function cliShape(command: string): string | null {
  const parsed = parseNamedCli(command);
  if (!parsed) return null;
  const positionals = parsed.positionals.map((p) => (/^\d+$/.test(p) ? "{id}" : p));
  return `${familyId(parsed)}${positionals.length ? ` ${positionals.join(" ")}` : ""}`;
}

function shapesOfString(s: string, into: Set<string>): void {
  if (/^https?:\/\//i.test(s)) {
    const sh = urlShape(s);
    if (sh) into.add(sh);
    return;
  }
  for (const u of extractCommandUrls(s)) {
    const sh = urlShape(u);
    if (sh) into.add(sh);
  }
  const cli = cliShape(s);
  if (cli) into.add(cli);
  const shape = commandShapeCached(s);
  if (shape && !NOISE_SHAPE.has(shape.name)) into.add(`cli:${shape.name}`);
}

const NOISE_SHAPE = new Set(["echo", "ls", "cd", "pwd", "cat", "sleep", "true", "false"]);

export function argShapes(args: Record<string, unknown>): string[] {
  const shapes = new Set<string>();
  for (const v of Object.values(args)) {
    if (typeof v === "string") shapesOfString(v, shapes);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") shapesOfString(x, shapes);
  }
  return [...shapes].sort();
}

export function programFirstStepShapes(p: StretchProgram): string[] {
  const strings: string[] = [];
  const step0 = p.steps[0] as ToolStep | undefined;
  if (step0 && step0.kind === "tool") {
    for (const b of Object.values(step0.args ?? {})) {
      if (!b || typeof b !== "object") continue;
      const bk = (b as { kind?: unknown }).kind;
      if (bk === "literal") {
        const v = (b as { value?: unknown }).value;
        if (typeof v === "string") strings.push(v);
      } else if (bk === "transform") {
        const expr = (b as { expr?: unknown }).expr;
        if (typeof expr === "string") strings.push(expr);
      }
    }
  }
  for (const vals of Object.values(p.contract.envelope?.inputs ?? {})) {
    if (Array.isArray(vals)) for (const v of vals) if (typeof v === "string") strings.push(v);
  }
  const shapes = new Set<string>();
  for (const s of strings) shapesOfString(s, shapes);
  return [...shapes].sort();
}

const MAX_SLOT_COMBOS = 200;

export function recoverShellInput(
  p: StretchProgram,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const step0 = p.steps[0] as ToolStep | undefined;
  if (!step0 || step0.kind !== "tool") return null;
  const live = typeof args.command === "string" ? args.command : null;
  if (!live) return null;
  for (const [k, b] of Object.entries(step0.args ?? {})) {
    if (k !== "command" || !b || typeof b !== "object") continue;
    const t = b as { kind?: unknown; fn?: unknown; expr?: unknown };
    if (t.kind !== "transform" || t.fn !== "template" || typeof t.expr !== "string") continue;
    const expr = t.expr as string;
    const slots = [...new Set([...expr.matchAll(/\{([\w.]+)\}/g)].map((m) => m[1]!))];
    if (!slots.length || slots.length > 4) continue;
    const pools = slots.map((path) => {
      const w = p.contract.envelope?.inputs?.[path];
      return { path, values: (Array.isArray(w) ? w : []).filter((v): v is string => typeof v === "string") };
    });
    if (pools.some((pool) => !pool.values.length)) continue;
    const total = pools.reduce((a, pool) => a * pool.values.length, 1);
    if (total > MAX_SLOT_COMBOS) continue;
    for (let combo = 0; combo < total; combo++) {
      let rest = combo;
      const input: Record<string, unknown> = {};
      for (let i = 0; i < pools.length; i++) {
        const pool = pools[pools.length - 1 - i]!;
        const idx = rest % pool.values.length;
        rest = Math.floor(rest / pool.values.length);
        setNested(input, pool.path.split("."), pool.values[idx]!);
      }
      if (interpolateSlots(expr, input) === live) return input;
    }
  }
  return null;
}

function setNested(obj: Record<string, unknown>, parts: string[], value: string): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cur[k];
    if (!next || typeof next !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = value;
}

export function firstCommandTemplate(p: StretchProgram): string | null {
  const step0 = p.steps[0] as ToolStep | undefined;
  if (!step0 || step0.kind !== "tool") return null;
  for (const [k, b] of Object.entries(step0.args ?? {})) {
    if (k !== "command" || !b || typeof b !== "object") continue;
    const t = b as { kind?: unknown; fn?: unknown; expr?: unknown };
    if (t.kind === "transform" && t.fn === "template" && typeof t.expr === "string") return t.expr;
  }
  return null;
}

export function templateFits(expr: string, live: string): boolean {
  const te = expr.split(/\s+/);
  const le = live.split(/\s+/);
  if (te.length !== le.length || !te.length) return false;
  const bin = (s: string[]) => s[0]!.replace(/^\{|\}$/g, "");
  if (bin(te) !== bin(le)) return false;
  if (te[1] !== le[1] && !/^\{\w+\}$/.test(te[1] ?? "") && !/^\{\w+\}$/.test(le[1] ?? "")) return false;
  const flags = (s: string[]) => s.filter((w) => w.startsWith("-")).sort();
  const tf = flags(te);
  const lf = flags(le);
  return tf.length === lf.length && tf.every((f, i) => f === lf[i]);
}

export function steerToolCalls(calls: OpenAiToolCall[], programs: StretchProgram[]): OpenAiToolCall[] {
  if (!calls.length || !programs.length) return calls;
  const live = programs.filter((p) => p.manifest);
  const first = calls[0]!;
  const name = first.function?.name || first.name || "";
  if (live.some((p) => p.name === name)) return calls;

  type Hit = { p: StretchProgram; input: Record<string, unknown>; by: "name" | "argshape" };
  const hits: Hit[] = [];
  for (const p of live) {
    const seq = p.sequence ?? [];
    if (!seq.length || seq[0] !== name) continue;
    const tmpl = firstCommandTemplate(p);
    if (tmpl) {
      const cmdLive = callArgs(first).command;
      if (typeof cmdLive !== "string" || !templateFits(tmpl, cmdLive)) continue;
      const recovered = recoverShellInput(p, callArgs(first));
      const input = recovered ?? extractInput(p, callArgs(first));
      if (!(inDistribution(p, input) || mayServe(p, input))) continue;
      hits.push({ p, input, by: "name" });
      continue;
    }
    const input = extractInput(p, callArgs(first));
    if (!(inDistribution(p, input) || mayServe(p, input))) continue;
    hits.push({ p, input, by: "name" });
  }
  if (!hits.length) {
    const sig = argShapes(callArgs(first));
    if (sig.length) {
      for (const p of live) {
        const psig = programFirstStepShapes(p);
        let input: Record<string, unknown> | null = null;
        const tmpl = firstCommandTemplate(p);
        if (tmpl) {
          const cmdLive = callArgs(first).command;
          if (typeof cmdLive !== "string" || !templateFits(tmpl, cmdLive)) continue;
          input = recoverShellInput(p, callArgs(first));
        } else {
          if (!psig.length || psig.length !== sig.length) continue;
          if (!psig.every((s, i) => s === sig[i])) continue;
          input = extractInput(p, callArgs(first));
        }
        if (!input || !(inDistribution(p, input) || mayServe(p, input))) continue;
        hits.push({ p, input, by: "argshape" });
      }
    }
  }

  hits.sort((a, b) => (b.p.sequence?.length ?? 0) - (a.p.sequence?.length ?? 0));
  const hit = hits[0];
  if (!hit) return calls;
  const steered: OpenAiToolCall & { matched_by?: "name" | "argshape" } = {
    id: first.id || `steer_${hit.p.id}`,
    type: "function",
    function: { name: hit.p.name, arguments: JSON.stringify(hit.input) },
    matched_by: hit.by,
  };
  const laterSteps = new Set((hit.p.sequence ?? []).slice(1));
  return [steered, ...calls.slice(1).filter((c) => !laterSteps.has(c.function?.name || c.name || ""))];
}

export function compiledSchema(program: StretchProgram) {
  return {
    type: "function" as const,
    function: {
      name: program.name,
      description: program.description,
      parameters: program.inputSchema,
    },
    allowed_callers: [...PTC_CALLERS],
    defer_loading: true as const,
  };
}

export function injectTools(tools: unknown, programs: StretchProgram[]): unknown {
  if (!Array.isArray(tools)) return tools;
  const live = programs.filter((p) => p.manifest);
  if (!live.length) return tools;
  const extra = live.map(compiledSchema);
  const names = new Set(live.map((p) => p.name));
  return [...extra, ...tools.filter((t) => !names.has(String((t as { function?: { name?: string } }).function?.name)))];
}
