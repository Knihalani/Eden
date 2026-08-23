import type { StretchProgram, ToolStep } from "@eden/ir";
import { inDistribution, asRecord, getPath, setKey } from "@eden/ir";
// Core helpers via relative paths (the same pattern the tests use); wrap does
// not declare a workspace dependency on core.
import { parameterizeUrl, extractCommandUrls } from "../../core/src/urls";
import { parseNamedCli, familyId } from "../../core/src/named-cli";

export type OpenAiToolCall = {
  id?: string;
  type?: string;
  function?: { name: string; arguments: string };
  name?: string;
  arguments?: unknown;
  /** How this call was matched to a compiled program. Absent on untouched calls. */
  matched_by?: "name" | "argshape";
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

/**
 * The URL shape of a concrete URL: parameterized, host kept, path kept, and
 * the GitHub-specific placeholders collapsed to {id} — exactly how the mine
 * side collapses them, so both sides of a comparison land on one spelling.
 */
function urlShape(url: string): string | null {
  const templated = parameterizeUrl(url);
  const m = templated.match(/^(https?:\/\/)([^/?#]+)([^?#]*)/i);
  if (!m) return null;
  return `${m[2]!}${m[3] || "/"}`.replaceAll("{issue}", "{id}").replaceAll("{run_id}", "{id}");
}

/** `gh pr view 123` -> `gh.pr.view {id}`; numeric positionals become {id}. */
function cliShape(command: string): string | null {
  const parsed = parseNamedCli(command);
  if (!parsed) return null;
  const positionals = parsed.positionals.map((p) => (/^\d+$/.test(p) ? "{id}" : p));
  return `${familyId(parsed)}${positionals.length ? ` ${positionals.join(" ")}` : ""}`;
}

/**
 * Every recognizable shape in one string: a bare URL, or URLs / a named CLI
 * call pulled out of a command string. Plain values (ticket ids, prose)
 * yield nothing, which is what makes this matcher fail closed.
 */
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
}

/** Sorted shape signature of a call's string arguments (top level + arrays). */
export function argShapes(args: Record<string, unknown>): string[] {
  const shapes = new Set<string>();
  for (const v of Object.values(args)) {
    if (typeof v === "string") shapesOfString(v, shapes);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") shapesOfString(x, shapes);
  }
  return [...shapes].sort();
}

/**
 * Shape signature of a live program's FIRST step: literal string bindings in
 * steps[0].args plus the string witness values from contract.envelope.inputs.
 * Empty when nothing identifiable is bound — such a program never matches by
 * arg shape.
 */
export function programFirstStepShapes(p: StretchProgram): string[] {
  const strings: string[] = [];
  const step0 = p.steps[0] as ToolStep | undefined;
  if (step0 && step0.kind === "tool") {
    for (const b of Object.values(step0.args ?? {})) {
      if (b && typeof b === "object" && (b as { kind?: unknown }).kind === "literal") {
        const v = (b as { value?: unknown }).value;
        if (typeof v === "string") strings.push(v);
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

export function steerToolCalls(calls: OpenAiToolCall[], programs: StretchProgram[]): OpenAiToolCall[] {
  if (!calls.length || !programs.length) return calls;
  const live = programs.filter((p) => p.manifest);
  const first = calls[0]!;
  const name = callName(first);
  if (live.some((p) => p.name === name)) return calls;

  type Hit = { p: StretchProgram; input: Record<string, unknown>; by: "name" | "argshape" };
  const hits: Hit[] = [];
  // Gate one: name prefix. The original signal; cheap and unambiguous.
  for (const p of live) {
    const seq = p.sequence ?? [];
    if (!seq.length || seq[0] !== name) continue;
    const input = extractInput(p, callArgs(first));
    if (!inDistribution(p, input)) continue;
    hits.push({ p, input, by: "name" });
  }
  // Gate two: argument shape, only when no name matched. Conservative on
  // purpose — exact signature equality against the program's first step,
  // never a fuzzy or partial match, and still behind inDistribution.
  if (!hits.length) {
    const sig = argShapes(callArgs(first));
    if (sig.length) {
      for (const p of live) {
        const psig = programFirstStepShapes(p);
        if (!psig.length || psig.length !== sig.length) continue;
        if (!psig.every((s, i) => s === sig[i])) continue;
        const input = extractInput(p, callArgs(first));
        if (!inDistribution(p, input)) continue;
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
  // The compiled run performs every later step of the matched sequence
  // itself, so siblings naming those steps are absorbed. Every OTHER sibling
  // — an unrelated webSearch next to a lookupTicket, say — is work the agent
  // asked for and must survive: returning only the steered call silently
  // dropped it.
  const laterSteps = new Set((hit.p.sequence ?? []).slice(1));
  return [steered, ...calls.slice(1).filter((c) => !laterSteps.has(callName(c)))];
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

/**
 * Offer the compiled tools alongside whatever the client already asked for.
 *
 * A client that sent no `tools` field at all has not opted into function
 * calling and has no handler for a tool call, so it gets none back. This used
 * to return `extra` whenever `tools` was not an array, so a plain completion
 * request came back with compiled tools attached and its reply steered into a
 * tool_calls response the caller could do nothing with. An empty array is
 * different: the client asked for function calling and simply has no tools of
 * its own, which is exactly who compiled tools are for.
 */
export function injectTools(tools: unknown, programs: StretchProgram[]): unknown {
  if (!Array.isArray(tools)) return tools;
  const live = programs.filter((p) => p.manifest);
  if (!live.length) return tools;
  const extra = live.map(compiledSchema);
  const names = new Set(live.map((p) => p.name));
  return [...extra, ...tools.filter((t) => !names.has(String((t as { function?: { name?: string } }).function?.name)))];
}
