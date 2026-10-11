import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  hookCommand,
  preHookCommand,
  installedHooks,
  mergeHooks,
  wrapMcpServer,
  geminiHookConfig,
  applyCodexToml,
  codexHooksJson,
  opencodePluginSource,
} from "./setup";
import * as setup from "./setup";
import { wrapPlaneUrl, sitePlaneUrl } from "./home";
import { remainderPath } from "./remainder";
import { MEMORY_HOOK_EVENTS, memoryHooksCheck } from "./doctor";

describe("setup hookd", () => {
  test("hooks fail-open through hookd then bun hook", () => {
    const cmd = hookCommand("/abs/cli.ts", 8794);
    expect(cmd).toContain("http://127.0.0.1:8794/hook");
    expect(cmd).toContain("bun '/abs/cli.ts' hook");
    expect(cmd.endsWith("|| true")).toBe(true);
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
    expect(hooks.UserPromptSubmit).toBeTruthy();
    expect(hooks.PreCompact).toBeTruthy();
    expect("PostToolUseFailure" in hooks).toBe(false);
  });

  test("PreToolUse is a fast fail-open probe and never cold-spawns the CLI", () => {
    const hooks = installedHooks(hookCommand("/abs/cli.ts", 8794));
    const pre = String(hooks.PreToolUse[0]!.hooks[0]!.command);
    expect(pre).toContain("--max-time 1");
    expect(pre.endsWith("|| true")).toBe(true);
    expect(pre).not.toContain("bun ");
    for (const event of [
      "PostToolUse",
      "PostToolBatch",
      "Stop",
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "PreCompact",
      "SubagentStop",
    ] as const) {
      const cmd = String(hooks[event]![0]!.hooks[0]!.command);
      expect(cmd).toContain("--max-time 8");
      expect(cmd).toContain("bun '/abs/cli.ts' hook");
    }
    expect(String(hooks.PostToolUse[0]!.hooks[0]!.command).endsWith("|| true")).toBe(true);
  });

  test("preHookCommand is explicit and installedHooks accepts an explicit pre command", () => {
    const pre = preHookCommand(9001);
    expect(pre).toContain("http://127.0.0.1:9001/hook");
    expect(pre).toContain("--max-time 1");
    expect(pre.endsWith("|| true")).toBe(true);
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
    expect(setup.installedCliPath()).toMatch(/cli\.ts|eden\.js|\/eden$/);
  });
});

describe("eden setup does not disarm the user's own hooks", () => {
  const warmCmd = "curl -sS http://127.0.0.1:8794/hook || bun '/abs/cli.ts' hook || true";
  const ours = installedHooks(warmCmd, warmCmd.replace(/ \|\| true$/, ""));

  const usersOwn = {
    PreToolUse: [{ hooks: [{ type: "command", command: "/usr/local/bin/allowlist-guard" }] }],
    Notification: [{ hooks: [{ type: "command", command: "say hi" }] }],
  };

  test("an existing hook on the same event survives", () => {
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
    const once = applyCodexToml('[model]\nname = "x"\n', post);
    expect(once).toContain('name = "x"');
    expect(once).toContain("eden-recorder");
    expect(once).toContain("hooks.json");
    expect(once).toContain("PostToolUse");
    expect(once).not.toContain("post_tool =");
    expect(once).not.toContain("[hooks.eden]");
    const twice = applyCodexToml(once, post);
    expect(twice).toBe(once);
    const stale = applyCodexToml(
      '[model]\nname = "x"\n# --- eden-recorder ---\n[hooks.eden]\npost_tool = ["sh"]\n# --- end eden-recorder ---\n',
      post,
    );
    expect(stale).not.toContain("[hooks.eden]");
    expect(stale).not.toContain("post_tool =");
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
    expect(toml).toContain("hooks.json");
    expect(toml).toContain("PostToolUse");
    expect(toml).not.toContain("post_tool =");
    expect(toml).not.toContain("[hooks.eden]");
    const hooks = codexHooksJson(hookCmd, preCmd);
    expect(JSON.stringify(hooks.hooks.PostToolUse)).toContain("EDEN_HOME");
    expect(JSON.stringify(hooks.hooks.PostToolUse)).toContain("|| true");
    expect(JSON.stringify(hooks.hooks.SessionStart)).toContain("EDEN_HOME");
    expect(JSON.stringify(hooks.hooks.Stop)).toContain("EDEN_HOME");
    expect(JSON.stringify(hooks.hooks.PreToolUse)).not.toContain("bun ");
    expect(JSON.stringify(hooks.hooks.PreToolUse)).toContain("|| true");

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
      } catch {}
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

describe("M49 memory hooks install without a wrap key", () => {
  test("installedHooks contains all 9 MEMORY_HOOK_EVENTS and doctor lists them", () => {
    const hookCmd = hookCommand("/abs/cli.ts");
    const hooks = installedHooks(hookCmd);
    for (const ev of MEMORY_HOOK_EVENTS) {
      expect(ev in hooks).toBe(true);
      expect(String(hooks[ev]![0]!.hooks[0]!.command)).toContain("bun '/abs/cli.ts' hook");
    }
    expect(MEMORY_HOOK_EVENTS).toHaveLength(9);
    const check = memoryHooksCheck({ hooks });
    expect(check.ok).toBe(true);
    expect(check.count).toBe(9);
    for (const ev of MEMORY_HOOK_EVENTS) expect(check.detail).toContain(ev);
  });

  test("setup source and installed hook commands have no Memorable, memory_search, or /forget", () => {
    const src = readFileSync(join(import.meta.dir, "setup.ts"), "utf8");
    const blob = src + JSON.stringify(installedHooks(hookCommand("/abs/cli.ts")));
    expect(blob).not.toContain("Memorable");
    expect(blob).not.toContain("memory_search");
    expect(blob).not.toContain("/forget");
  });

  test("setup with no wrap key still writes the 9 events and does not touch the real home", async () => {
    const prev = {
      home: process.env.HOME,
      eden: process.env.EDEN_HOME,
      key: process.env.EDEN_API_KEY,
      dev: process.env.EDEN_DEV,
      token: process.env.EDEN_SETUP_TOKEN,
      base: process.env.EDEN_BASE_URL,
      wrap: process.env.EDEN_WRAP_URL,
      site: process.env.EDEN_SITE_URL,
      siteMcp: process.env.EDEN_SITE_MCP,
      cwd: process.cwd(),
      log: console.log,
    };
    const root = mkdtempSync(join(tmpdir(), "eden-setup-m49-"));
    const home = join(root, "home");
    const eden = join(root, "eden");
    const cwd = join(root, "cwd");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const realClaude = join(homedir(), ".claude", "settings.json");
    const realBefore = existsSync(realClaude) ? statSync(realClaude).mtimeMs : null;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    process.env.HOME = home;
    process.env.EDEN_HOME = eden;
    delete process.env.EDEN_API_KEY;
    delete process.env.EDEN_DEV;
    delete process.env.EDEN_SETUP_TOKEN;
    delete process.env.EDEN_BASE_URL;
    delete process.env.EDEN_WRAP_URL;
    delete process.env.EDEN_SITE_URL;
    delete process.env.EDEN_SITE_MCP;
    process.chdir(cwd);
    try {
      await setup.setup([]);
      const settingsPath = join(home, ".claude", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
      const check = memoryHooksCheck(settings);
      expect(check.ok).toBe(true);
      expect(check.count).toBe(9);
      // Setup's PostToolUse leaves memory to its PostToolBatch (P0.7), which the check names in that slot.
      for (const ev of MEMORY_HOOK_EVENTS) expect(check.detail).toContain(ev === "PostToolUse" ? "PostToolBatch" : ev);
      expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
      expect(existsSync(join(eden, "config.json"))).toBe(false);
      const written = readFileSync(settingsPath, "utf8") + lines.join("\n");
      expect(written).not.toContain("Memorable");
      expect(written).not.toContain("memory_search");
      expect(written).not.toContain("/forget");
      expect(lines.join("\n")).toContain("memory on by default");
      const realAfter = existsSync(realClaude) ? statSync(realClaude).mtimeMs : null;
      expect(realAfter).toBe(realBefore);
    } finally {
      console.log = prev.log;
      process.chdir(prev.cwd);
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("HOME", prev.home);
      restore("EDEN_HOME", prev.eden);
      restore("EDEN_API_KEY", prev.key);
      restore("EDEN_DEV", prev.dev);
      restore("EDEN_SETUP_TOKEN", prev.token);
      restore("EDEN_BASE_URL", prev.base);
      restore("EDEN_WRAP_URL", prev.wrap);
      restore("EDEN_SITE_URL", prev.site);
      restore("EDEN_SITE_MCP", prev.siteMcp);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("setup --dev still writes the 9 events plus wrap config inside an isolated home", async () => {
    const prev = {
      home: process.env.HOME,
      eden: process.env.EDEN_HOME,
      key: process.env.EDEN_API_KEY,
      dev: process.env.EDEN_DEV,
      token: process.env.EDEN_SETUP_TOKEN,
      cwd: process.cwd(),
      log: console.log,
    };
    const root = mkdtempSync(join(tmpdir(), "eden-setup-m49-dev-"));
    const home = join(root, "home");
    const eden = join(root, "eden");
    const cwd = join(root, "cwd");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    console.log = () => {};
    process.env.HOME = home;
    process.env.EDEN_HOME = eden;
    delete process.env.EDEN_API_KEY;
    delete process.env.EDEN_DEV;
    delete process.env.EDEN_SETUP_TOKEN;
    process.chdir(cwd);
    try {
      await setup.setup(["--dev"]);
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as unknown;
      const check = memoryHooksCheck(settings);
      expect(check.ok).toBe(true);
      expect(check.count).toBe(9);
      // Setup's PostToolUse leaves memory to its PostToolBatch (P0.7), which the check names in that slot.
      for (const ev of MEMORY_HOOK_EVENTS) expect(check.detail).toContain(ev === "PostToolUse" ? "PostToolBatch" : ev);
      const cfg = JSON.parse(readFileSync(join(eden, "config.json"), "utf8")) as { api_key?: string };
      expect(cfg.api_key).toBe("eden_dev");
      expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
      const mcp = readFileSync(join(cwd, ".mcp.json"), "utf8");
      expect(mcp).not.toContain("Memorable");
      expect(mcp).not.toContain("memory_search");
      expect(mcp).not.toContain("/forget");
    } finally {
      console.log = prev.log;
      process.chdir(prev.cwd);
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("HOME", prev.home);
      restore("EDEN_HOME", prev.eden);
      restore("EDEN_API_KEY", prev.key);
      restore("EDEN_DEV", prev.dev);
      restore("EDEN_SETUP_TOKEN", prev.token);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("M14 Codex PostToolUse fail-open / cursor not invented", () => {
  test("codex hooks.json PostToolUse stays fail-open; cursor hooks are not invented", () => {
    const hookCmd = hookCommand("/abs/cli.ts", 8794);
    const preCmd = preHookCommand(8794);
    expect(hookCmd.endsWith("|| true")).toBe(true);
    const hooks = JSON.stringify(codexHooksJson(hookCmd, preCmd));
    expect(hooks).toContain("PostToolUse");
    expect(hooks).not.toContain("echo");
    expect(hooks).toContain("SessionStart");
    expect(hooks).toContain("Stop");
    expect(applyCodexToml("", hookCmd, preCmd)).not.toContain("post_tool =");

    expect("cursorHookConfig" in setup).toBe(false);
    expect(Object.keys(setup).filter((k) => /cursor/i.test(k))).toEqual([]);
    expect(opencodePluginSource("/abs/cli.ts")).not.toContain("cursor");
  });
});
