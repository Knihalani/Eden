import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { hookCommand } from "./setup";

describe("setup hookd", () => {
  test("hooks fail-open through hookd then bun hook", () => {
    const cmd = hookCommand("/abs/cli.ts", 8794);
    expect(cmd).toContain("http://127.0.0.1:8794/hook");
    expect(cmd).toContain('bun "/abs/cli.ts" hook');
    expect(cmd).toContain("|| echo '{}'");
    expect(cmd.indexOf("curl")).toBe(0);
  });
});
