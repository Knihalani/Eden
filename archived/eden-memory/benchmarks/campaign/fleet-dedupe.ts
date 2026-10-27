/**
 * Wave 7.1 rotation: two agents, one fleet, one read-only GET.
 * Duplicate fetches vanish. Mutating stays session-isolated.
 */
import { sharedAcrossLine, type Receipt, type ToolDef } from "@eden/wrap";
import { linearProgram } from "./struggle-harness";

export const FLEET_FETCH_BEFORE = 2;
export const FLEET_FETCH_AFTER = 1;

export function readOnlyFetchProgram(id = "p_fetch") {
  return linearProgram(id, ["fetchIssue", "fetchComments"]);
}

export function fetchTools(execs: Record<string, number>): Record<string, ToolDef> {
  return {
    fetchIssue: {
      description: "fetchIssue",
      execute: async (args) => {
        const id = String(args.id);
        execs[`fetchIssue:${id}`] = (execs[`fetchIssue:${id}`] ?? 0) + 1;
        return { id: args.id, title: "bug" };
      },
    },
    fetchComments: {
      description: "fetchComments",
      execute: async (args) => {
        const id = String(args.id);
        execs[`fetchComments:${id}`] = (execs[`fetchComments:${id}`] ?? 0) + 1;
        return { id: args.id, comments: [] };
      },
    },
  };
}

export function sharedLine(receipts: Receipt[]): string | undefined {
  return receipts.map((r) => r.reason).find((r) => typeof r === "string" && r.includes(sharedAcrossLine(2)));
}
