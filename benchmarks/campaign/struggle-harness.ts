/**
 * Shared oblivious driver for struggle probes and the Wave 4 concurrency matrix.
 * Exactly-once is the only pass: a duplicated mutation is a shipped bug.
 */
import { withVersion, type Step, type StretchProgram } from "@eden/ir";
import type { ToolDef } from "@eden/wrap";

export function linearProgram(id: string, sequence: string[], opts: { text?: boolean } = {}): StretchProgram {
  const steps: Step[] = sequence.map((tool, i) => ({
    id: tool,
    kind: "tool",
    tool,
    args: {
      id: { kind: "input", path: "id" },
      ...(i === 0 && opts.text ? { text: { kind: "input", path: "text" } } : {}),
    },
  }));
  return withVersion({
    id,
    name: id,
    description: "d",
    inputSchema: {
      type: "object",
      properties: opts.text ? { id: { type: "string" }, text: { type: "string" } } : { id: { type: "string" } },
      required: opts.text ? ["id", "text"] : ["id"],
    },
    sequence,
    steps,
    returns: { kind: "from", step: sequence[sequence.length - 1]!, path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true },
    manifest: {
      llmReduction: 5,
      latencyReduction: 2,
      costReduction: 5,
      skipRateBefore: 0,
      skipRateAfter: 0,
      nShadow: 3,
    },
  }) as StretchProgram;
}

/** Oblivious driver: fires the full script for each goal. Optional think delay between calls. */
export async function fireOblivious(
  wrapped: Record<string, ToolDef>,
  script: Array<{ tool: string; args: Record<string, unknown> }>,
  thinkMs = 0,
): Promise<void> {
  if (thinkMs <= 0) {
    await Promise.all(script.map((c) => wrapped[c.tool]!.execute(c.args)));
    return;
  }
  await Promise.all(
    script.map(async (c) => {
      await Bun.sleep(thinkMs);
      await wrapped[c.tool]!.execute(c.args);
    }),
  );
}

export function mutatingWorld(sequence: string[]): {
  tools: Record<string, ToolDef>;
  writes: Record<string, number>;
  execs: Record<string, number>;
} {
  const writes: Record<string, number> = {};
  const execs: Record<string, number> = {};
  const last = sequence[sequence.length - 1]!;
  const writeNames = new Set(sequence.filter((n) => /write|audit|apply|notify|email/i.test(n) || n === last));
  const tools: Record<string, ToolDef> = {};
  for (const name of sequence) {
    tools[name] = {
      description: name,
      execute: async (args: Record<string, unknown>) => {
        const id = String(args.id);
        execs[`${name}:${id}`] = (execs[`${name}:${id}`] ?? 0) + 1;
        if (writeNames.has(name) && name !== sequence[0]) writes[`${name}:${id}`] = (writes[`${name}:${id}`] ?? 0) + 1;
        return { name, id: args.id };
      },
    };
  }
  return { tools, writes, execs };
}
