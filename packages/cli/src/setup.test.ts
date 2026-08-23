import { describe, expect, test } from "bun:test";
import { hookCommand, preHookCommand, installedHooks, mergeHooks, wrapMcpServer } from "./setup";
import { wrapPlaneUrl, sitePlaneUrl } from "./home";

describe("setup hookd", () => {
  test("hooks fail-open through hookd then bun hook", () => {
    const cmd = hookCommand("/abs/cli.ts", 8794);
    expect(cmd).toContain("http://127.0.0.1:8794/hook");
    // Single-quoted: this string is persisted into settings.json and run by a
    // shell on every tool call, and double quotes do not stop $(...).
    expect(cmd).toContain("bun '/abs/cli.ts' hook");
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

  test("PreToolUse is a fast fail-open probe and never cold-spawns the CLI", () => {
    // UPDATED BEHAVIOUR: this test previously encoded the blocking design —
    // PreToolUse inherited the full Post/Stop chain (`--max-time 8` curl then
    // a cold `bun <cli> hook` spawn) with no `|| echo '{}'` fail-open. That
    // meant a tool call blocked up to 8s+ whenever hookd was down. PreToolUse
    // now gets its own command: `curl --max-time 1 … || echo '{}'`, no bun
    // spawn at all — ordinary tool calls never wait on Eden.
    const hooks = installedHooks(hookCommand("/abs/cli.ts", 8794));
    const pre = String(hooks.PreToolUse[0]!.hooks[0]!.command);
    expect(pre).toContain("--max-time 1");
    expect(pre).toContain("|| echo '{}'");
    expect(pre).not.toContain("bun ");
    // The warm chain stays on Post/Stop/SessionStart.
    for (const event of ["PostToolUse", "Stop", "SessionStart"] as const) {
      const cmd = String(hooks[event]![0]!.hooks[0]!.command);
      expect(cmd).toContain("--max-time 8");
      expect(cmd).toContain("bun '/abs/cli.ts' hook");
    }
    expect(String(hooks.PostToolUse[0]!.hooks[0]!.command)).toContain("echo '{}'");
  });

  test("preHookCommand is explicit and installedHooks accepts an explicit pre command", () => {
    const pre = preHookCommand(9001);
    expect(pre).toContain("http://127.0.0.1:9001/hook");
    expect(pre).toContain("--max-time 1");
    expect(pre.endsWith("|| echo '{}'")).toBe(true);
    const preCmd = "my-own-pre-hook --fast";
    const hooks = installedHooks("warm-chain-cmd", preCmd);
    expect(hooks.PreToolUse[0]!.hooks[0]!.command).toBe(preCmd);
    expect(hooks.PostToolUse[0]!.hooks[0]!.command).toBe("warm-chain-cmd");
  });

  test("compiled-tools MCP is stdio bun mcp on wrap 8788", () => {
    expect(wrapPlaneUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8788");
    expect(sitePlaneUrl("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8787");
    expect(wrapPlaneUrl("https://wrap.example.com")).toBe("https://wrap.example.com");
    expect(wrapMcpServer("/abs/cli.ts")).toEqual({ command: "bun", args: ["/abs/cli.ts", "mcp"] });
  });
});

describe("eden setup does not disarm the user's own hooks", () => {
  const warmCmd = "curl -sS http://127.0.0.1:8794/hook || bun '/abs/cli.ts' hook || echo '{}'";
  const ours = installedHooks(warmCmd, warmCmd.replace(/ \|\| echo '\{\}'$/, ""));

  const usersOwn = {
    PreToolUse: [{ hooks: [{ type: "command", command: "/usr/local/bin/allowlist-guard" }] }],
    Notification: [{ hooks: [{ type: "command", command: "say hi" }] }],
  };

  test("an existing hook on the same event survives", () => {
    // A shallow spread replaced the user's PreToolUse array outright, so
    // anyone with their own command allowlist, audit log or secret scanner
    // silently lost it the first time they ran `eden setup`.
    const merged = mergeHooks(usersOwn, ours);
    const commands = merged.PreToolUse!.flatMap((e) => e.hooks!.map((h) => h.command));
    expect(commands).toContain("/usr/local/bin/allowlist-guard");
    expect(commands.some((c) => /cli\.ts' hook/.test(String(c)))).toBe(true);
  });

  test("an event Eden does not touch is left exactly alone", () => {
    expect(mergeHooks(usersOwn, ours).Notification).toEqual(usersOwn.Notification);
  });

  test("running setup twice does not install two copies", () => {
    const once = mergeHooks(usersOwn, ours);
    const twice = mergeHooks(once, ours);
    expect(twice).toEqual(once);
    expect(twice.PreToolUse).toHaveLength(2); // the user's, and exactly one of ours
  });

  test("settings with no hooks at all still get ours", () => {
    expect(Object.keys(mergeHooks(undefined, ours)).sort()).toEqual(Object.keys(ours).sort());
    expect(Object.keys(mergeHooks({}, ours)).sort()).toEqual(Object.keys(ours).sort());
  });

  test("a shell substitution in the install path is not executed", () => {
    // The command is persisted into settings.json and run by a shell on every
    // tool call. Double quotes do not stop $(...) or backticks.
    const cmd = hookCommand("/tmp/$(touch /tmp/pwned)/cli.ts", 8794);
    expect(cmd).toContain("'/tmp/$(touch /tmp/pwned)/cli.ts'");
    expect(cmd).not.toContain('"/tmp/$(touch /tmp/pwned)/cli.ts"');
  });

  test("a path containing a quote cannot break out of its quoting", () => {
    const cmd = hookCommand("/tmp/it's/cli.ts", 8794);
    expect(cmd).toContain(`'/tmp/it'\\''s/cli.ts'`);
  });
});
