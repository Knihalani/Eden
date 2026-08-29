import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hookCommand, preHookCommand, installedHooks, mergeHooks, wrapMcpServer, geminiHookConfig, applyCodexToml, opencodePluginSource } from "./setup";
import * as setup from "./setup";
import { wrapPlaneUrl, sitePlaneUrl } from "./home";
import { remainderPath } from "./remainder";

describe("setup hookd", () => {
  test("hooks fail-open through hookd then bun hook", () => {
    const cmd = hookCommand("/abs/cli.ts", 8794);
    expect(cmd).toContain("http://127.0.0.1:8794/hook");
    // Single-quoted: this string is persisted into settings.json and run by a
    // shell on every tool call, and double quotes do not stop $(...).
    expect(cmd).toContain("bun '/abs/cli.ts' hook");
    expect(cmd).toContain("|| echo '{}'");
    expect(cmd).toContain("--max-time 8");
    expect(cmd.startsWith("export EDEN_HOME=")).toBe(true);
    expect(cmd).toContain("curl -sS --max-time 8");
  });

  test("installed hooks match the fair bench surface", () => {
    const hooks = installedHooks("curl …");
    expect("matcher" in hooks.PreToolUse[0]!).toBe(false);
    expect("matcher" in hooks.PostToolUse[0]!).toBe(false);
    expect("matcher" in hooks.PostToolBatch[0]!).toBe(false);
    expect(hooks.PostToolBatch).toHaveLength(1);
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
    // The warm chain stays on Post/Stop/SessionStart/PostToolBatch.
    for (const event of ["PostToolUse", "PostToolBatch", "Stop", "SessionStart"] as const) {
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

  test("PostToolBatch is installed once, no matcher, same warm command as PostToolUse", () => {
    expect(ours.PostToolBatch).toBeTruthy();
    expect(ours.PostToolBatch).toHaveLength(1);
    expect("matcher" in ours.PostToolBatch[0]!).toBe(false);
    expect(ours.PostToolBatch[0]!.hooks[0]!.command).toBe(ours.PostToolUse[0]!.hooks[0]!.command);
    const once = mergeHooks({}, ours);
    const twice = mergeHooks(once, ours);
    expect(twice.PostToolBatch).toHaveLength(1);
    expect(twice.PostToolUse).toHaveLength(1);
    expect(twice).toEqual(once);
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

describe("multi-agent installer", () => {
  const pre = "curl -sS --max-time 1 … || echo '{}'";
  const post = "curl -sS --max-time 8 … || bun cli.ts hook || echo '{}'";

  test("gemini config merges without clobbering unrelated keys", () => {
    const existing = { theme: "dark", hooks: { UserPromptSubmit: [{ command: "mine" }] } };
    const out = geminiHookConfig(existing, pre, post) as Record<string, any>;
    expect(out.theme).toBe("dark");
    expect((out.hooks as any).UserPromptSubmit).toBeDefined();
    expect((out.hooks as any).BeforeToolUse).toEqual([{ command: pre }]);
    expect((out.hooks as any).AfterToolUse).toEqual([{ command: post }]);
    expect((out.hooks as any).AfterTool).toEqual([{ command: post }]);
  });

  test("gemini re-run replaces the Eden rewriter and does not stack", () => {
    const existing = {
      hooks: {
        AfterToolUse: [{ command: "mine" }, { command: "curl -sS http://127.0.0.1:8794/hook" }],
      },
    };
    const once = geminiHookConfig(existing, pre, post) as Record<string, any>;
    const twice = geminiHookConfig(once, pre, post) as Record<string, any>;
    expect(twice).toEqual(once);
    const after = once.hooks.AfterToolUse as Array<{ command: string }>;
    expect(after.filter((e) => e.command === "mine")).toHaveLength(1);
    expect(after.filter((e) => e.command === post)).toHaveLength(1);
    expect(after).toHaveLength(2);
  });

  test("codex toml append is idempotent and replaces only the managed section", () => {
    const once = applyCodexToml("[model]\nname = \"x\"\n", post);
    expect(once).toContain('name = "x"');
    expect(once).toContain("eden-recorder");
    expect(once).toContain("post_tool");
    expect(once).toContain("pre_tool");
    expect((once.match(/post_tool =/g) ?? []).length).toBe(1);
    const twice = applyCodexToml(once, post);
    expect(twice).toBe(once);
  });

  test("opencode plugin source is fail-open and rewrites output.output", () => {
    const src = opencodePluginSource("/abs/cli.ts");
    expect(src).toContain("AbortSignal.timeout(bunFallback ? 8000 : 1000)");
    expect(src).toContain("output.output");
    expect(src).toContain("mcpShaped");
    expect(src).toContain("tool.execute.after");
    expect(src).toContain("tool.execute.before");
    expect(src).toContain("permissionDecision");
    expect(src).toContain("a broken plugin never blocks the tool");
    expect(src).toContain("project?.directory");
    expect(src).not.toContain("cursor");
    expect(src).not.toContain("windsurf");
    expect(src).not.toContain("cline");
  });

  test("installer does not invent Cursor / Windsurf / Cline hooks", () => {
    expect("cursorHookConfig" in setup).toBe(false);
    expect("windsurfHookConfig" in setup).toBe(false);
    expect("clineHookConfig" in setup).toBe(false);
    expect(Object.keys(setup).filter((k) => /cursor|windsurf|cline/i.test(k))).toEqual([]);
  });

  test("Gemini AfterTool, Codex post_tool, and OpenCode bake EDEN_HOME like Claude", () => {
    const cli = join(import.meta.dir, "cli.ts");
    const hookCmd = hookCommand(cli, 8794);
    const preCmd = preHookCommand(8794);
    expect(hookCmd.startsWith("export EDEN_HOME=")).toBe(true);
    expect((preCmd.match(/bun /g) ?? []).length).toBe(0);
    expect(preCmd).toContain("--max-time 1");

    const gemini = geminiHookConfig({}, preCmd, hookCmd) as Record<string, any>;
    const afterTool = String((gemini.hooks as any).AfterTool[0].command);
    const afterToolUse = String((gemini.hooks as any).AfterToolUse[0].command);
    expect(afterTool).toContain("EDEN_HOME");
    expect(afterTool).toContain("export EDEN_HOME=");
    expect(afterTool).toBe(hookCmd);
    expect(afterToolUse).toContain("EDEN_HOME");
    const beforeTool = String((gemini.hooks as any).BeforeTool[0].command);
    expect(beforeTool).not.toContain("bun ");
    expect(beforeTool).toBe(preCmd);

    const toml = applyCodexToml("", hookCmd, preCmd);
    const postLine = toml.split("\n").find((l) => l.includes("post_tool ="));
    expect(postLine).toBeTruthy();
    expect(postLine!).toContain("EDEN_HOME");
    expect(toml).toContain("export EDEN_HOME=");
    const startLine = toml.split("\n").find((l) => l.includes("session_start ="));
    const stopLine = toml.split("\n").find((l) => l.includes("session_stop ="));
    expect(startLine!).toContain("EDEN_HOME");
    expect(stopLine!).toContain("EDEN_HOME");
    const preLine = toml.split("\n").find((l) => l.includes("pre_tool ="));
    expect(preLine!).not.toContain("bun ");

    const src = opencodePluginSource(cli);
    expect(src).toContain("const EDEN_HOME =");
    expect(src).toContain("EDEN_HOME");
    expect(src).toContain('spawnSync("bun", [CLI, "hook"]');
    expect(src).toContain("env: { ...process.env, EDEN_HOME }");
    expect(src).toContain("if (bunFallback) return await bunHook(payload)");
    expect(src).toContain("cwd: project?.directory");
    expect(src).toMatch(/tool\.execute\.before[\s\S]*await send\(\{[\s\S]*cwd: project\?\.directory,[\s\S]*\}\)/);
    expect(src).toMatch(/tool\.execute\.after[\s\S]*await send\(\{[\s\S]*\}, true\)/);
  });

  test("custom EDEN_HOME bun fallback writes remainder under that dir not ~/.eden", async () => {
    const prevHome = process.env.EDEN_HOME;
    const prevHookd = process.env.EDEN_HOOKD;
    const prevPort = process.env.EDEN_HOOKD_PORT;
    const prevSteer = process.env.EDEN_STEER_HOOKS;
    const home = "/tmp/eden-w17-home";
    const defaultRemainder = join(homedir(), ".eden", "remainder.json");
    const defaultBefore = existsSync(defaultRemainder) ? readFileSync(defaultRemainder, "utf8") : null;
    const port = 31000 + Math.floor(Math.random() * 2000);
    rmSync(home, { recursive: true, force: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_HOOKD = "0";
    process.env.EDEN_HOOKD_PORT = String(port);
    delete process.env.EDEN_STEER_HOOKS;
    try {
      mkdirSync(join(home, "runs"), { recursive: true });
      const cli = join(import.meta.dir, "cli.ts");
      const src = opencodePluginSource(cli);
      expect(src).toContain(`const EDEN_HOME = ${JSON.stringify(home)}`);
      expect(src).toContain(`const CLI = ${JSON.stringify(cli)}`);
      const bakedHome = src.match(/const EDEN_HOME = ("(?:\\.|[^"\\])*")/);
      const bakedCli = src.match(/const CLI = ("(?:\\.|[^"\\])*")/);
      expect(bakedHome).toBeTruthy();
      expect(bakedCli).toBeTruthy();
      const edenHomeBaked = JSON.parse(bakedHome![1]!) as string;
      const cliBaked = JSON.parse(bakedCli![1]!) as string;
      expect(edenHomeBaked).toBe(home);
      expect(cliBaked).toBe(cli);

      // cwd-hop program: bun PostToolBatch arms remainder; hookd PreToolUse claims.
      writeFileSync(
        join(home, "live-tools.json"),
        JSON.stringify([{ name: "pr_write", sequence: ["Read", "Grep", "Write"], id: "t-write" }]),
      );

      const CWD = "/Users/me/repo";
      const REL = "./a.ts";
      const ABS = resolve(CWD, REL);
      const rem = remainderPath();
      expect(rem).toBe(join(home, "remainder.json"));
      expect(rem).not.toBe(defaultRemainder);
      expect(existsSync(rem)).toBe(false);

      const proc = Bun.spawn(["bun", cliBaked, "hook"], {
        env: { ...process.env, EDEN_HOME: edenHomeBaked, EDEN_HOOKD: "0" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(
        JSON.stringify({
          hook_event_name: "PostToolBatch",
          session_id: "w17-home",
          cwd: CWD,
          tool_calls: [
            { tool_name: "Read", tool_input: { file_path: REL }, tool_response: "ok" },
            { tool_name: "Grep", tool_input: { pattern: "TODO", path: REL }, tool_response: "ok" },
            { tool_name: "Write", tool_input: { file_path: REL, content: "x" }, tool_response: "ok" },
          ],
        }),
      );
      proc.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(existsSync(rem)).toBe(true);
      const childStat = statSync(rem);
      const childWrote = readFileSync(rem, "utf8");
      const store = JSON.parse(childWrote) as { sessions?: Record<string, unknown> };
      expect(Object.keys(store.sessions ?? {}).length).toBeGreaterThan(0);
      expect(childStat.mtimeMs).toBeGreaterThan(0);
      expect(stdout).toContain("pr_write");
      expect(stdout).not.toContain("eden_timeout");
      expect(stderr).not.toContain("eden hook:");

      const { startHookdBackground, stopHookd, hookdHealthy } = await import("./hookd");
      delete process.env.EDEN_HOOKD;
      expect(await startHookdBackground()).toBe(true);
      expect(await hookdHealthy()).toBe(true);
      try {
        const preCmd = preHookCommand(port);
        expect(preCmd).not.toContain("bun ");
        const claim = Bun.spawn(["sh", "-c", preCmd], {
          stdin: new Blob([
            JSON.stringify({
              hook_event_name: "PreToolUse",
              session_id: "w17-home",
              cwd: CWD,
              tool_name: "Write",
              tool_input: { file_path: ABS },
            }),
          ]),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, EDEN_HOME: edenHomeBaked, EDEN_HOOKD_PORT: String(port) },
        });
        const [claimOut, claimCode] = await Promise.all([new Response(claim.stdout).text(), claim.exited]);
        expect(claimCode).toBe(0);
        const claimed = JSON.parse(claimOut.trim() || "{}") as {
          hookSpecificOutput?: { permissionDecision?: string };
        };
        expect(claimed.hookSpecificOutput?.permissionDecision).toBe("deny");
      } finally {
        stopHookd();
      }

      const defaultAfter = existsSync(defaultRemainder) ? readFileSync(defaultRemainder, "utf8") : null;
      expect(defaultAfter).toBe(defaultBefore);
    } finally {
      try {
        const { stopHookd } = await import("./hookd");
        stopHookd();
      } catch {
        /* best-effort */
      }
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      if (prevHookd === undefined) delete process.env.EDEN_HOOKD;
      else process.env.EDEN_HOOKD = prevHookd;
      if (prevPort === undefined) delete process.env.EDEN_HOOKD_PORT;
      else process.env.EDEN_HOOKD_PORT = prevPort;
      if (prevSteer === undefined) delete process.env.EDEN_STEER_HOOKS;
      else process.env.EDEN_STEER_HOOKS = prevSteer;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
