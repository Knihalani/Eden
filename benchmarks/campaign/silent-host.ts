/**
 * Silent-host rotation world: an unscrapable provider. Traces carry no
 * prompt_tokens; go-live must stay UNCERTIFIED / not installed.
 */
import type { World } from "./worlds";

export const SILENT_HOST_IDS = ["SH-1", "SH-2", "SH-3"] as const;

export function createSilentHost(): World {
  const writes = new Map<string, number>();
  return {
    name: "silent-host",
    island: () => async ({ input }) => ({ note: "unscrapable", input }),
    tools: () => ({
      fetchItem: {
        description: "Fetch an item.",
        execute: async ({ id }) => ({ id, v: 1 }),
      },
      judgeItem: {
        description: "Judge the item. Model judgment.",
        execute: async ({ id }) => ({ ok: true, id }),
      },
      writeItem: {
        description: "Write the item. Mutating.",
        execute: async ({ id }) => {
          writes.set(String(id), (writes.get(String(id)) ?? 0) + 1);
          return { written: true, id };
        },
      },
      sealItem: {
        description: "Seal the item.",
        execute: async ({ id }) => ({ sealed: true, id }),
      },
    }),
    async *script(goal) {
      const id = String(goal.id);
      yield { tool: "fetchItem", args: { id } };
      yield { tool: "judgeItem", args: { id } };
      yield { tool: "writeItem", args: { id } };
      const last = yield { tool: "sealItem", args: { id } };
      void last;
    },
    done: (v) => Boolean((v as { sealed?: boolean })?.sealed),
    terminal: "sealItem",
    check(goals) {
      const occ = new Map<string, number>();
      for (const g of goals) {
        const k = String(g.id);
        occ.set(k, (occ.get(k) ?? 0) + 1);
      }
      const bad: string[] = [];
      for (const [id, n] of occ) {
        const got = writes.get(id) ?? 0;
        if (got > n) bad.push(`silent-host:${id}: writeItem ran ${got}x across ${n} stretch(es)`);
      }
      return bad;
    },
  };
}
