import { describe, expect, test } from "bun:test";
import { hookCommand, installedHooks, wrapMcpServer } from "./setup";
import { wrapPlaneUrl, sitePlaneUrl } from "./home";

describe("setup hookd", () => {
  test("hooks fail-open through hookd then bun hook", () => {
    const cmd = hookCommand("/abs/cli.ts", 8794);
    expect(cmd).toContain("http://127.0.0.1:8794/hook");
    expect(cmd).toContain('bun "/abs/cli.ts" hook');
    expect(cmd).toContain("|| echo '{}'");
    expect(cmd).toContain("--max-time 8");
    expect(cmd.indexOf("curl")).toBe(0);
  });

  test("installed hooks match the fair bench surface", () => {
    const hooks = installedHooks("curl …");
    expect("matcher" in hooks.PreToolUse[0]!).toBe(false);
    expect("matcher" in hooks.PostToolUse[0]!).toBe(false);
    expect(hooks.Stop).toBeTruthy();
    expect(hooks.SessionStart).toBeTruthy();
    expect("UserPromptSubmit" in hooks).toBe(false);
    expect("PostToolUseFailure" in hooks).toBe(false);
  });

  test("PreToolUse does not fail-open allow with echo", () => {
    const cmd = hookCommand("/abs/cli.ts", 8794);
    const hooks = installedHooks(cmd);
    expect(hooks.PreToolUse[0]!.hooks[0]!.command).not.toContain("echo '{}'");
    expect(hooks.PostToolUse[0]!.hooks[0]!.command).toContain("echo '{}'");
    expect(hookCommand("/abs/cli.ts", 8794, { failOpen: false })).not.toContain("echo '{}'");
  });

  test("compiled-tools MCP is stdio bun mcp on wrap 8788", () => {
    expect(wrapPlaneUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8788");
    expect(sitePlaneUrl("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8787");
    expect(wrapPlaneUrl("https://wrap.example.com")).toBe("https://wrap.example.com");
    expect(wrapMcpServer("/abs/cli.ts")).toEqual({ command: "bun", args: ["/abs/cli.ts", "mcp"] });
  });
});
