import type { StretchProgram } from "@eden/ir";
import { inDistribution, asRecord, getPath, setKey } from "@eden/ir";

export type OpenAiToolCall = {
  id?: string;
  type?: string;
  function?: { name: string; arguments: string };
  name?: string;
  arguments?: unknown;
};

function callName(c: OpenAiToolCall): string {
  return c.function?.name || c.name || "";
}

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
  // setKey rather than `out[k] =`: a key named "__proto__" runs the inherited
  // setter instead of defining a property, which both loses the input and
  // installs it as the prototype of the args object handed to the tool.
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

export function steerToolCalls(calls: OpenAiToolCall[], programs: StretchProgram[]): OpenAiToolCall[] {
  if (!calls.length || !programs.length) return calls;
  const live = programs.filter((p) => p.manifest);
  const first = calls[0]!;
  const name = callName(first);
  if (live.some((p) => p.name === name)) return calls;
  const hits: StretchProgram[] = [];
  for (const p of live) {
    const seq = p.sequence ?? [];
    if (!seq.length || seq[0] !== name) continue;
    const input = extractInput(p, callArgs(first));
    if (!inDistribution(p, input)) continue;
    hits.push(p);
  }
  hits.sort((a, b) => (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0));
  const p = hits[0];
  if (!p) return calls;
  return [
    {
      id: first.id || `steer_${p.id}`,
      type: "function",
      function: { name: p.name, arguments: JSON.stringify(extractInput(p, callArgs(first))) },
    },
  ];
}

export function compiledSchema(program: StretchProgram) {
  return {
    type: "function" as const,
    function: {
      name: program.name,
      description: program.description,
      parameters: program.inputSchema,
    },
  };
}

export function injectTools(tools: unknown, programs: StretchProgram[]): unknown {
  const live = programs.filter((p) => p.manifest);
  if (!live.length) return tools;
  const extra = live.map(compiledSchema);
  if (!Array.isArray(tools)) return extra;
  const names = new Set(live.map((p) => p.name));
  return [...extra, ...tools.filter((t) => !names.has(String((t as { function?: { name?: string } }).function?.name)))];
}
