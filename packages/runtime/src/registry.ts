import type { ToolExecute, ToolRegistry } from "@eden/ir";
import { DeoptError } from "./deopt";

export function registryFrom(
  tools: Record<string, ToolExecute | { execute: ToolExecute }>,
): ToolRegistry {
  const map = new Map<string, ToolExecute>();
  for (const [name, def] of Object.entries(tools)) {
    map.set(name, typeof def === "function" ? def : def.execute.bind(def));
  }
  return {
    has: (name) => map.has(name),
    execute: async (name, args, ctx) => {
      const fn = map.get(name);
      if (!fn) throw new Error(`unknown tool ${name}`);
      if (ctx?.signal?.aborted) throw new DeoptError("aborted");
      return fn(args, ctx);
    },
  };
}
