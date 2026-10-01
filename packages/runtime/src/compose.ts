import type { IslandCaller, StretchProgram, ToolExecute, ToolRegistry } from "@eden/ir";
import { runProgram } from "./execute";

/**
 * Composed registries: a compiled tool becomes callable AS a tool.
 *
 * Voyager's skill library lets skills call lower-level skills; without the
 * same layering here, a compiled stretch cannot reuse an earlier one — every
 * workflow re-implements its building blocks from scratch. This adapter
 * makes sub-programs addressable through the registry so a parent program's
 * steps can target them by name, while receipts flow through normally.
 *
 * Recursive composition works naturally: a sub-program's own registry can
 * contain further sub-programs. Cycle detection is the caller's job — the
 * compiler refuses self-referencing clusters before they reach this layer.
 */
export interface SubProgramEntry {
  program: StretchProgram;
  /** Overrides the base registry for this sub-program's own tool calls. */
  registry?: ToolRegistry;
  island?: IslandCaller;
  llmCents?: number;
  timeoutMs?: number;
}

/**
 * Sub-program timeout: explicit, then env, then a generous default. The old hard 30s truncated any
 * longer legitimate sub-program into a mid-parent deopt.
 */
function subTimeoutMs(explicit?: number): number {
  if (explicit && explicit > 0) return Math.min(600_000, explicit);
  const env = Number(process.env.EDEN_SUB_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return Math.min(600_000, env);
  return 120_000;
}

export function composedRegistry(
  base: Record<string, ToolExecute | { execute: ToolExecute }>,
  subPrograms: Record<string, SubProgramEntry> = {},
): ToolRegistry {
  const toolMap = new Map<string, ToolExecute>();
  for (const [name, def] of Object.entries(base)) {
    toolMap.set(name, typeof def === "function" ? def : def.execute.bind(def));
  }

  const subMap = new Map<string, SubProgramEntry>(Object.entries(subPrograms));

  return {
    has: (name) => subMap.has(name) || toolMap.has(name),
    execute: async (name, args, ctx) => {
      const sub = subMap.get(name);
      if (sub) {
        // Run the compiled sub-program. Its own tool calls resolve against
        // its dedicated registry when one was provided — that is the whole
        // point of the field; it used to be dead and every sub-program
        // silently shared this layer's base tools. Cancellation propagates
        // from the parent run into the child.
        const innerRegistry = sub.registry ?? {
          has: (n) => toolMap.has(n),
          execute: async (n, a, c) => {
            const fn2 = toolMap.get(n);
            if (!fn2) throw new Error(`composedRegistry: unknown tool ${n}`);
            if (c?.signal?.aborted) throw new Error("aborted");
            return fn2(a, c);
          },
        };
        const out = await runProgram(sub.program, args, {
          registry: innerRegistry,
          island: sub.island,
          checkEnvelope: false,
          timeoutMs: subTimeoutMs(sub.timeoutMs),
          signal: ctx?.signal,
        });
        return out.value;
      }
      const fn = toolMap.get(name);
      if (!fn) throw new Error(`unknown tool ${name}`);
      return fn(args, ctx);
    },
  };
}
