import { describe, expect, test } from "bun:test";
import { hookCommand, installedHooks } from "./setup";

describe("setup hookd", () => {
  test("hooks fail-open through hookd then bun hook", () => {
    const cmd = hookCommand("/abs/cli.ts", 8794);
    expect(cmd).toContain("http://127.0.0.1:8794/hook");
    expect(cmd).toContain('bun "/abs/cli.ts" hook');
    expect(cmd).toContain("|| echo '{}'");
    expect(cmd).toContain("--max-time 2");
    expect(cmd.indexOf("curl")).toBe(0);
  });

  test("installed hooks match the fair bench surface", () => {
    const hooks = installedHooks("curl …");
    expect(hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(hooks.PostToolUse[0].matcher).toBe("Bash");
    expect(hooks.Stop).toBeTruthy();
    expect(hooks.SessionStart).toBeTruthy();
    expect("UserPromptSubmit" in hooks).toBe(false);
    expect("PostToolUseFailure" in hooks).toBe(false);
  });
});
