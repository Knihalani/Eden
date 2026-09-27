import { PTC_CALLERS, type ToolRegistry } from "@eden/ir";
import { DeoptError } from "@eden/runtime";

export function codingRegistry(_cwd = process.cwd()): ToolRegistry {
  return {
    has: () => false,
    allowed_callers: [...PTC_CALLERS],
    execute: async () => {
      throw new DeoptError("coding registry stub");
    },
  };
}
