import { describe, expect, test } from "bun:test";
import { respondToHook, applyFlushTruncate, hookTraceBody } from "./hook";
import { handleHookd, hookdTimeoutMs } from "./hookd";
import { handleMcp, McpAuthError, mcpHelp, runMcp } from "./mcp";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";

describe("hook", () => {
  test("hook flush payload does not invent llmCalls from the event count", () => {
    const body = hookTraceBody([
      { name: "lookupTicket", args: { id: "T-100" }, ok: true, result: { id: "T-100" }, ts: 1 },
      { name: "notify", args: { id: "T-100" }, ok: true, result: { sent: true }, ts: 4 },
    ]);
    expect(body.llmCalls).toBe(0);
    expect(body.cost_cents).toBe(0);
    expect(body.output).toEqual({ sent: true });
  });

  test("PostToolUse records without throwing", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook");
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    const out = await respondToHook({
      hook_event_name: "PostToolUse",
      session_id: "s1",
      tool_name: "lookupTicket",
      tool_input: { id: "T-100", api_key: "sk-secret" },
      tool_response: { ok: true },
    });
    expect(out.ok).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("session of 8 PostToolUse events flushes one stretch", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook3");
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:9" }));
    for (let i = 0; i < 8; i++) {
      await respondToHook({
        hook_event_name: "PostToolUse",
        session_id: "agg",
        tool_name: i === 7 ? "notify" : `step${i}`,
        tool_input: { id: "T-100" },
        tool_response: { ok: true },
      });
    }
    const raw = readFileSync(join(home, "runs", "agg.jsonl"), "utf8");
    expect(raw.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(8);
    rmSync(home, { recursive: true, force: true });
  });

  test("PostToolUse advances the flushed-cursor sidecar once per event", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-cursor");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    for (let i = 0; i < 3; i++) {
      await respondToHook({
        hook_event_name: "PostToolUse",
        session_id: "cur",
        tool_name: `step${i}`,
        tool_input: {},
        tool_response: { ok: true },
      });
    }
    const cursorPath = join(home, "runs", "cur.jsonl.cursor.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as { lines: number };
    const actual = readFileSync(join(home, "runs", "cur.jsonl"), "utf8").split("\n").filter(Boolean).length;
    expect(cursor.lines).toBe(actual);

    rmSync(cursorPath);
    await respondToHook({
      hook_event_name: "PostToolUse",
      session_id: "cur",
      tool_name: "step3",
      tool_input: {},
      tool_response: { ok: true },
    });
    const rebuilt = JSON.parse(readFileSync(cursorPath, "utf8")) as { lines: number };
    const afterRebuild = readFileSync(join(home, "runs", "cur.jsonl"), "utf8").split("\n").filter(Boolean).length;
    expect(rebuilt.lines).toBe(afterRebuild);
    expect(rebuilt.lines).toBe(4);

    const path = join(home, "runs", "cur.jsonl");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const ids = lines.slice(0, 2).map((l) => String((JSON.parse(l) as { id?: string }).id));
    applyFlushTruncate(path, ids);
    const truncated = JSON.parse(readFileSync(cursorPath, "utf8")) as { lines: number };
    expect(truncated.lines).toBe(readFileSync(path, "utf8").split("\n").filter(Boolean).length);
    expect(truncated.lines).toBe(2);
    rmSync(home, { recursive: true, force: true });
  });

  test("flush truncate keeps events that arrived after the snapshot", () => {
    const home = join(import.meta.dir, "../../.tmp-eden-flush");
    mkdirSync(join(home, "runs"), { recursive: true });
    const path = join(home, "runs", "s.jsonl");
    writeFileSync(path, `${JSON.stringify({ id: "a", name: "a" })}\n${JSON.stringify({ id: "b", name: "b" })}\n${JSON.stringify({ id: "c", name: "c" })}\n`);
    applyFlushTruncate(path, ["a", "b"]);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).name).toBe("c");
    applyFlushTruncate(path, ["c"]);
    expect(readFileSync(path, "utf8")).toBe("");
    rmSync(home, { recursive: true, force: true });
  });

  test("PreToolUse steers toward compiled MCP tool only when opted in", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook2");
    mkdirSync(home, { recursive: true });
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "live-tools.json"), JSON.stringify([{ name: "resolve_ticket", sequence: ["lookupTicket"] }]));
    delete process.env.EDEN_STEER_HOOKS;
    const observe = await respondToHook({ hook_event_name: "PreToolUse", tool_name: "lookupTicket", tool_input: { id: "T-100" } });
    expect((observe as { ok?: boolean }).ok).toBe(true);
    process.env.EDEN_STEER_HOOKS = "1";
    try {
      const out = await respondToHook({ hook_event_name: "PreToolUse", tool_name: "lookupTicket", tool_input: { id: "T-100" } });
      expect((out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe("deny");
      writeFileSync(
        join(home, "live-tools.json"),
        JSON.stringify([{ name: "resolve_ticket", sequence: ["lookupTicket"], envelope: { inputs: { id: ["T-100", "T-101", "T-102"] } } }]),
      );
      const ood = await respondToHook({ hook_event_name: "PreToolUse", tool_name: "lookupTicket", tool_input: { id: "T-999" } });
      expect((ood as { ok?: boolean }).ok).toBe(true);
      const self = await respondToHook({ hook_event_name: "PreToolUse", tool_name: "resolve_ticket", tool_input: { id: "T-100" } });
      expect((self as { ok?: boolean }).ok).toBe(true);
    } finally {
      delete process.env.EDEN_STEER_HOOKS;
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("Stop writes stretch_end to outbox", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook-stop");
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    await respondToHook({ hook_event_name: "Stop", session_id: "s-stop" });
    const box = readFileSync(join(home, "outbox.jsonl"), "utf8");
    expect(box).toContain("stretch_end");
    expect(box).toContain("s-stop");
    rmSync(home, { recursive: true, force: true });
  });

  test("hookd health is json and timeout defaults to 8s", async () => {
    delete process.env.EDEN_HOOKD_TIMEOUT_MS;
    expect(hookdTimeoutMs()).toBe(8000);
    const r = await handleHookd(new Request("http://x/health"));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; service: string; pid: number };
    expect(j.ok).toBe(true);
    expect(j.service).toBe("eden-hookd");
    expect(j.pid).toBe(process.pid);
  });

  test("eden hook overlaps hookd warm with the one-shot so PreToolUse curl can deny", () => {
    const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
    const hook = cli.slice(cli.indexOf('cmd === "hook"'), cli.indexOf('cmd === "mcp"'));
    expect(hook).toContain("startHookdBackground");
    expect(readFileSync(join(import.meta.dir, "wrap-cmd.ts"), "utf8")).toContain("bootHookdFromWrap");
  });

  test("startHookdBackground is a no-op when EDEN_HOOKD=0", async () => {
    const { startHookdBackground, waitForHookdHealth } = await import("./hookd");
    const { bootHookdFromWrap } = await import("./wrap-cmd");
    const prev = process.env.EDEN_HOOKD;
    const prevPort = process.env.EDEN_HOOKD_PORT;
    process.env.EDEN_HOOKD = "0";
    process.env.EDEN_HOOKD_PORT = "59999";
    try {
      expect(await startHookdBackground()).toBe(false);
      expect(await bootHookdFromWrap()).toBe(false);
      const t0 = Date.now();
      expect(await waitForHookdHealth(1)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(400);
    } finally {
      if (prev === undefined) delete process.env.EDEN_HOOKD;
      else process.env.EDEN_HOOKD = prev;
      if (prevPort === undefined) delete process.env.EDEN_HOOKD_PORT;
      else process.env.EDEN_HOOKD_PORT = prevPort;
    }
  });

  test("hookd pid file: stale is not alive; --stop on missing is 0", async () => {
    const { writeHookdPid, readHookdPid, hookdPidAlive, clearHookdPid, stopHookd, hookdPidPath } = await import("./hookd");
    const home = join(import.meta.dir, "../../.tmp-eden-hookd-pid");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const prev = process.env.EDEN_HOME;
    const prevPort = process.env.EDEN_HOOKD_PORT;
    process.env.EDEN_HOME = home;
    process.env.EDEN_HOOKD_PORT = String(29111 + (process.pid % 500));
    const err: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      err.push(a.map(String).join(" "));
    };
    try {
      expect(readHookdPid()).toBeNull();
      expect(await stopHookd()).toBe(0);
      expect(err.join("\n")).toMatch(/not running/);
      writeHookdPid(process.pid);
      expect(readHookdPid()).toBe(process.pid);
      expect(hookdPidAlive(process.pid)).toBe(true);
      expect(hookdPidAlive(99999999)).toBe(false);
      writeHookdPid(99999999);
      expect(hookdPidAlive(readHookdPid()!)).toBe(false);
      err.length = 0;
      expect(await stopHookd()).toBe(0);
      expect(err.join("\n")).toMatch(/not running/);
      expect(readHookdPid()).toBeNull();
      clearHookdPid();
      expect(hookdPidPath()).toContain("hookd.pid");
    } finally {
      console.error = orig;
      if (prev === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prev;
      if (prevPort === undefined) delete process.env.EDEN_HOOKD_PORT;
      else process.env.EDEN_HOOKD_PORT = prevPort;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("stopHookd SIGTERMs the /health pid when hookd.pid is stale", async () => {
    const { writeHookdPid, stopHookd, clearHookdPid } = await import("./hookd");
    const home = join(import.meta.dir, "../../.tmp-eden-hookd-orphan-stop");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const port = String(29200 + (process.pid % 400));
    const prevHome = process.env.EDEN_HOME;
    const prevPort = process.env.EDEN_HOOKD_PORT;
    process.env.EDEN_HOME = home;
    process.env.EDEN_HOOKD_PORT = port;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "hookd.ts")], {
      env: { ...process.env, EDEN_HOME: home, EDEN_HOOKD_PORT: port },
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    });
    const err: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      err.push(a.map(String).join(" "));
    };
    try {
      let health: { ok?: boolean; pid?: number; service?: string } | null = null;
      for (let i = 0; i < 50; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(200) });
          if (r.ok) {
            health = (await r.json()) as typeof health;
            break;
          }
        } catch {}
        await Bun.sleep(40);
      }
      expect(health?.ok).toBe(true);
      expect(health?.service).toBe("eden-hookd");
      expect(health?.pid).toBe(child.pid);
      writeHookdPid(99999999);
      expect(await stopHookd()).toBe(0);
      expect(err.join("\n")).toMatch(new RegExp(`stopped ${health!.pid} \\(live /health pid`));
      expect(err.join("\n")).toMatch(/pid file was 99999999/);
      let down = false;
      for (let i = 0; i < 40; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(150) });
          down = !r.ok;
        } catch {
          down = true;
        }
        if (down) break;
        await Bun.sleep(40);
      }
      expect(down).toBe(true);
    } finally {
      console.error = orig;
      try {
        if (child.pid) process.kill(child.pid, "SIGKILL");
      } catch {}
      clearHookdPid();
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      if (prevPort === undefined) delete process.env.EDEN_HOOKD_PORT;
      else process.env.EDEN_HOOKD_PORT = prevPort;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Post then Pre remainder deny without EDEN_STEER_HOOKS; ledger rows land", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook-remainder");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_TRANSPARENT = "1";
    process.env.EDEN_API_KEY = "eden_dev";
    delete process.env.EDEN_STEER_HOOKS;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:9" }));
    writeFileSync(
      join(home, "live-tools.json"),
      JSON.stringify([
        {
          name: "pr_summary",
          sequence: ["Read", "Grep", "Bash"],
          id: "t1",
          read_only: true,
          envelope: { inputs: { issue: ["101", "102"] } },
        },
      ]),
    );
    const prevFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        if (String(url).includes("/v1/play")) {
          return new Response(JSON.stringify({ ok: true, table: "reviews=6 | status=pending" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
      { preconnect: prevFetch.preconnect },
    );
    try {
      const post = (await respondToHook({
        hook_event_name: "PostToolUse",
        session_id: "loop",
        tool_name: "Read",
        tool_input: { issue: "101", file_path: "/repo/pr.ts" },
        tool_response: {
          type: "text",
          file: { filePath: "/repo/pr.ts", content: "export {}", numLines: 1, startLine: 1, totalLines: 1 },
        },
      })) as {
        hookSpecificOutput?: {
          updatedToolOutput?: { file?: { content?: string; filePath?: string } };
          additionalContext?: string;
        };
      };
      expect(post.hookSpecificOutput?.updatedToolOutput?.file?.filePath).toBe("/repo/pr.ts");
      expect(post.hookSpecificOutput?.updatedToolOutput?.file?.content).toContain("[eden:pr_summary]");
      expect(post.hookSpecificOutput?.additionalContext).toContain("[eden:pr_summary]");

      const grep = (await respondToHook({
        hook_event_name: "PreToolUse",
        session_id: "loop",
        tool_name: "Grep",
        tool_input: { issue: "101", pattern: "TODO" },
      })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      expect(grep.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(grep.hookSpecificOutput?.permissionDecisionReason).toBe(
        "Already served by pr_summary. Do not re-run Grep — facts are in the last tool output or attached as context.",
      );

      const bash = (await respondToHook({
        hook_event_name: "PreToolUse",
        session_id: "loop",
        tool_name: "Bash",
        tool_input: { issue: "101", command: "gh pr view" },
      })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      expect(bash.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(bash.hookSpecificOutput?.permissionDecisionReason).toContain("pr_summary");
      expect(bash.hookSpecificOutput?.permissionDecisionReason).toContain("Bash");

      const ledger = readFileSync(join(home, "ledger.jsonl"), "utf8");
      expect(ledger).toContain('"class":"transparent"');
      expect(ledger).toContain('"class":"steered-skip"');
      expect(ledger.split("\n").filter((l) => l.includes("steered-skip")).length).toBe(2);
      expect(ledger).not.toContain('"class":"host-drop"');
    } finally {
      globalThis.fetch = prevFetch;
      delete process.env.EDEN_TRANSPARENT;
      delete process.env.EDEN_API_KEY;
      delete process.env.EDEN_STEER_HOOKS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("PostToolBatch two reads after transparent head → remainder claims both names on PreToolUse", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook-postbatch");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_TRANSPARENT = "1";
    process.env.EDEN_API_KEY = "eden_dev";
    delete process.env.EDEN_STEER_HOOKS;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:9" }));
    writeFileSync(
      join(home, "live-tools.json"),
      JSON.stringify([
        {
          name: "pr_summary",
          sequence: ["Read", "Grep", "Bash"],
          id: "t1",
          read_only: true,
          envelope: { inputs: { issue: ["101", "102"] } },
        },
      ]),
    );
    const prevFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        if (String(url).includes("/v1/play")) {
          return new Response(JSON.stringify({ ok: true, table: "reviews=6 | status=pending" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
      { preconnect: prevFetch.preconnect },
    );
    try {
      const post = (await respondToHook({
        hook_event_name: "PostToolUse",
        session_id: "batch",
        tool_name: "Read",
        tool_input: { issue: "101", file_path: "/repo/pr.ts" },
        tool_response: {
          type: "text",
          file: { filePath: "/repo/pr.ts", content: "export {}", numLines: 1, startLine: 1, totalLines: 1 },
        },
      })) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(post.hookSpecificOutput?.additionalContext).toContain("[eden:pr_summary]");

      const batch = (await respondToHook({
        hook_event_name: "PostToolBatch",
        session_id: "batch",
        tool_calls: [
          { tool_name: "Grep", tool_input: { issue: "101", pattern: "TODO" }, tool_use_id: "g1", tool_response: "ok" },
          { tool_name: "Bash", tool_input: { issue: "101", command: "gh pr view" }, tool_use_id: "b1", tool_response: "ok" },
        ],
      })) as { hookSpecificOutput?: { additionalContext?: string; hookEventName?: string }; decision?: string };
      expect(batch.decision).toBeUndefined();
      expect(JSON.stringify(batch)).not.toMatch(/"decision"\s*:\s*"block"/);
      expect(batch.hookSpecificOutput?.hookEventName).toBe("PostToolBatch");
      expect(batch.hookSpecificOutput?.additionalContext).toContain("pr_summary");

      const grep = (await respondToHook({
        hook_event_name: "PreToolUse",
        session_id: "batch",
        tool_name: "Grep",
        tool_input: { issue: "101", pattern: "TODO" },
      })) as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(grep.hookSpecificOutput?.permissionDecision).toBe("deny");

      const bash = (await respondToHook({
        hook_event_name: "PreToolUse",
        session_id: "batch",
        tool_name: "Bash",
        tool_input: { issue: "101", command: "gh pr view" },
      })) as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(bash.hookSpecificOutput?.permissionDecision).toBe("deny");
    } finally {
      globalThis.fetch = prevFetch;
      delete process.env.EDEN_TRANSPARENT;
      delete process.env.EDEN_API_KEY;
      delete process.env.EDEN_STEER_HOOKS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("garbage PostToolBatch → {}", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook-postbatch-garbage");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    try {
      expect(await respondToHook({ hook_event_name: "PostToolBatch" })).toEqual({});
      expect(await respondToHook({ hook_event_name: "PostToolBatch", tool_calls: "nope" as never })).toEqual({});
      expect(await respondToHook({ hook_event_name: "PostToolBatch", tool_calls: { foo: 1 } as never })).toEqual({});
      const blocked = await respondToHook({ hook_event_name: "PostToolBatch", tool_calls: null as never });
      expect(blocked).toEqual({});
      expect((blocked as { decision?: string }).decision).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("PostToolBatch head-in-batch: mutating execute stays 1; PreToolUse denies the rest", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook-postbatch-mutate");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    delete process.env.EDEN_STEER_HOOKS;
    writeFileSync(
      join(home, "live-tools.json"),
      JSON.stringify([
        {
          name: "pr_write",
          sequence: ["Read", "Grep", "Write"],
          id: "t-write",
          envelope: { inputs: { issue: ["101"] } },
        },
      ]),
    );
    let mutate = 0;
    const executeWrite = () => {
      mutate += 1;
      return { wrote: true };
    };
    try {
      executeWrite();
      expect(mutate).toBe(1);

      const batch = await respondToHook({
        hook_event_name: "PostToolBatch",
        session_id: "mut",
        tool_calls: [
          { tool_name: "Read", tool_input: { issue: "101", file_path: "/repo/pr.ts" }, tool_response: "ok" },
          { tool_name: "Grep", tool_input: { issue: "101", pattern: "TODO" }, tool_response: "ok" },
          { tool_name: "Write", tool_input: { issue: "101", file_path: "/repo/pr.ts" }, tool_response: "ok" },
        ],
      });
      expect((batch as { decision?: string }).decision).toBeUndefined();

      const grep = (await respondToHook({
        hook_event_name: "PreToolUse",
        session_id: "mut",
        tool_name: "Grep",
        tool_input: { issue: "101", pattern: "TODO" },
      })) as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(grep.hookSpecificOutput?.permissionDecision).toBe("deny");

      const write = (await respondToHook({
        hook_event_name: "PreToolUse",
        session_id: "mut",
        tool_name: "Write",
        tool_input: { issue: "101", file_path: "/repo/pr.ts" },
      })) as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(write.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(mutate).toBe(1);
    } finally {
      delete process.env.EDEN_STEER_HOOKS;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("OpenCode lowercase tools and Gemini AfterToolUse map into HookIn", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook-hosts");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_TRANSPARENT = "1";
    process.env.EDEN_API_KEY = "eden_dev";
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:9" }));
    writeFileSync(
      join(home, "live-tools.json"),
      JSON.stringify([
        {
          name: "pr_summary",
          sequence: ["Read", "Grep", "Bash"],
          id: "t1",
          read_only: true,
          envelope: { inputs: { issue: ["101", "102"] } },
        },
      ]),
    );
    const prevFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        if (String(url).includes("/v1/play")) {
          return new Response(JSON.stringify({ ok: true, table: "reviews=6 | status=pending" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
      { preconnect: prevFetch.preconnect },
    );
    try {
      const post = (await respondToHook({
        hook_event_name: "AfterToolUse",
        session_id: "oc",
        tool_name: "read",
        tool_input: { issue: "101", file_path: "/repo/pr.ts" },
        tool_response: { llmContent: "export {}", returnDisplay: "export {}" },
      } as never)) as {
        hookSpecificOutput?: { additionalContext?: string; updatedToolOutput?: unknown };
        decision?: string;
      };
      expect(post.hookSpecificOutput?.additionalContext).toContain("[eden:pr_summary]");

      const grep = (await respondToHook({
        hook_event_name: "BeforeToolUse",
        session_id: "oc",
        tool_name: "grep",
        tool_input: { issue: "101", pattern: "TODO" },
      } as never)) as {
        decision?: string;
        reason?: string;
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(grep.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(grep.decision).toBe("deny");
      expect(grep.reason).toContain("pr_summary");
    } finally {
      globalThis.fetch = prevFetch;
      delete process.env.EDEN_TRANSPARENT;
      delete process.env.EDEN_API_KEY;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("canary live-tools do not transparently serve hosted sessions outside the bucket", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook-canary");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_TRANSPARENT = "1";
    process.env.EDEN_API_KEY = "eden_dev";
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:9" }));
    writeFileSync(
      join(home, "live-tools.json"),
      JSON.stringify([
        {
          name: "pr_summary",
          sequence: ["Read", "Grep", "Bash"],
          id: "t1",
          read_only: true,
          rollout: "canary",
          envelope: { inputs: { issue: ["101", "102"] } },
        },
      ]),
    );
    const { inCanary } = await import("@eden/ir");
    let out = "";
    for (let i = 0; i < 400 && !out; i++) if (!inCanary(`sess-${i}`)) out = `sess-${i}`;
    const prevFetch = globalThis.fetch;
    let played = 0;
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        if (String(url).includes("/v1/play")) {
          played++;
          return new Response(JSON.stringify({ ok: true, table: "reviews=6" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
      { preconnect: prevFetch.preconnect },
    );
    try {
      const skipped = (await respondToHook({
        hook_event_name: "PostToolUse",
        session_id: out,
        tool_name: "Read",
        tool_input: { issue: "101", file_path: "/repo/pr.ts" },
        tool_response: {
          type: "text",
          file: { filePath: "/repo/pr.ts", content: "export {}", numLines: 1, startLine: 1, totalLines: 1 },
        },
      })) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(skipped.hookSpecificOutput?.additionalContext).toBeUndefined();
      expect(played).toBe(0);

      const operator = (await respondToHook({
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { issue: "101", file_path: "/repo/pr.ts" },
        tool_response: {
          type: "text",
          file: { filePath: "/repo/pr.ts", content: "export {}", numLines: 1, startLine: 1, totalLines: 1 },
        },
      })) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(operator.hookSpecificOutput?.additionalContext).toContain("[eden:pr_summary]");
      expect(played).toBe(1);
    } finally {
      globalThis.fetch = prevFetch;
      delete process.env.EDEN_TRANSPARENT;
      delete process.env.EDEN_API_KEY;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("steer_hooks still works as before (opt-in MCP deny is not remainder)", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook-steer-still");
    mkdirSync(home, { recursive: true });
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "live-tools.json"), JSON.stringify([{ name: "resolve_ticket", sequence: ["lookupTicket"] }]));
    delete process.env.EDEN_STEER_HOOKS;
    const observe = await respondToHook({
      hook_event_name: "PreToolUse",
      tool_name: "lookupTicket",
      tool_input: { id: "T-100" },
    });
    expect((observe as { ok?: boolean }).ok).toBe(true);
    process.env.EDEN_STEER_HOOKS = "1";
    try {
      const out = await respondToHook({
        hook_event_name: "PreToolUse",
        tool_name: "lookupTicket",
        tool_input: { id: "T-100" },
      });
      expect((out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe(
        "deny",
      );
      expect(
        (out as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason,
      ).toContain("resolve_ticket");
    } finally {
      delete process.env.EDEN_STEER_HOOKS;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("mcp", () => {
  test("--help is a letter and does not start stdio", async () => {
    expect(mcpHelp()).toMatch(/^eden mcp —/);
    expect(mcpHelp()).toMatch(/does not start stdio/);
    expect(mcpHelp()).toMatch(/Does not Approve/);
    const logs: string[] = [];
    const log = console.log;
    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ""));
    };
    try {
      await runMcp(["--help"]);
    } finally {
      console.log = log;
    }
    expect(logs.join("\n")).toBe(mcpHelp());
  });

  test("initialize returns server info", async () => {
    let sent: unknown;
    await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      {
        base: "http://x",
        key: "k",
        programs: async () => [],
        send: (_id, result) => {
          sent = result;
        },
      },
    );
    expect((sent as { serverInfo: { name: string } }).serverInfo.name).toBe("eden");
  });

  test("ping returns an empty result", async () => {
    let sent: unknown = "unset";
    await handleMcp(
      { jsonrpc: "2.0", id: 3, method: "ping" },
      {
        base: "http://x",
        key: "k",
        programs: async () => [],
        send: (_id, result) => {
          sent = result;
        },
      },
    );
    expect(sent).toEqual({});
  });

  test("resources/list and prompts/list are empty catalogs", async () => {
    const seen: Record<string, unknown> = {};
    for (const method of ["resources/list", "prompts/list"]) {
      await handleMcp(
        { jsonrpc: "2.0", id: method, method },
        {
          base: "http://x",
          key: "k",
          programs: async () => [],
          send: (_id, result) => {
            seen[method] = result;
          },
        },
      );
    }
    expect(seen["resources/list"]).toEqual({ resources: [] });
    expect(seen["prompts/list"]).toEqual({ prompts: [] });
  });

  test("resources/list is an empty catalog even when programs are live; resources/read still serves a known uri", async () => {
    const program = {
      id: "p_abc",
      version: "v",
      name: "ticket_stretch",
      description: "compiled stretch",
      inputSchema: { type: "object" },
      steps: [],
      returns: { kind: "literal" as const, value: null },
      contract: { witnesses: 3, minLlmReduction: 5, allowExact: false },
      manifest: null,
    };
    let listed: unknown;
    let read: unknown;
    await handleMcp(
      { jsonrpc: "2.0", id: "list", method: "resources/list" },
      {
        base: "http://x",
        key: "k",
        programs: async () => [program],
        send: (_id, result) => {
          listed = result;
        },
      },
    );
    await handleMcp(
      { jsonrpc: "2.0", id: "read", method: "resources/read", params: { uri: "eden://program/p_abc" } },
      {
        base: "http://x",
        key: "k",
        programs: async () => [program],
        send: (_id, result) => {
          read = result;
        },
      },
    );
    expect(listed).toEqual({ resources: [] });
    expect((read as { contents: Array<{ text: string }> }).contents[0]!.text).toContain("ticket_stretch");
  });

  test("tools/list is an empty catalog even when programs are live", async () => {
    const program = {
      id: "p_def",
      version: "v",
      name: "ticket_stretch",
      description: "compiled stretch",
      inputSchema: { type: "object" },
      steps: [],
      returns: { kind: "literal" as const, value: null },
      contract: { witnesses: 3, minLlmReduction: 5, allowExact: false },
      manifest: null,
    };
    let listed: { tools?: unknown[] } | undefined;
    await handleMcp(
      { jsonrpc: "2.0", id: "list", method: "tools/list" },
      {
        base: "http://x",
        key: "k",
        programs: async () => [program],
        send: (_id, result) => {
          listed = result as typeof listed;
        },
      },
    );
    expect(listed?.tools).toEqual([]);
  });

  test("tools/list 401 is a JSON-RPC error not an empty catalog", async () => {
    let err: { code?: number; message?: string } | undefined;
    let result: unknown;
    await handleMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        base: "http://x",
        key: "k",
        programs: async () => {
          throw new McpAuthError();
        },
        send: (_id, r) => {
          result = r;
        },
        error: (_id, code, message) => {
          err = { code, message };
        },
      },
    );
    expect(result).toBeUndefined();
    expect(err).toEqual({ code: -32001, message: "unauthorized" });
  });

  test("resources/list 401 is a JSON-RPC error not an empty catalog", async () => {
    let err: { code?: number; message?: string } | undefined;
    let result: unknown;
    await handleMcp(
      { jsonrpc: "2.0", id: 3, method: "resources/list" },
      {
        base: "http://x",
        key: "k",
        programs: async () => {
          throw new McpAuthError();
        },
        send: (_id, r) => {
          result = r;
        },
        error: (_id, code, message) => {
          err = { code, message };
        },
      },
    );
    expect(result).toBeUndefined();
    expect(err).toEqual({ code: -32001, message: "unauthorized" });
  });

  const GH_DISPATCH = {
    id: "p_gh",
    version: "v1",
    name: "github_pr_bundle",
    description: "PR bundle",
    inputSchema: { type: "object", properties: {} },
    steps: [
      {
        id: "s0",
        kind: "tool" as const,
        tool: "web_fetch",
        args: { u: { kind: "literal" as const, value: "https://api.github.com/repos/acme/app/pulls/12" } },
      },
    ],
    returns: { kind: "literal" as const, value: null },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
    manifest: {} as never,
    sequence: ["web_fetch"],
  };
  const GH_MSG = [
    { role: "user", content: "Look at https://api.github.com/repos/acme/app/pulls/12 and summarize the reviews" },
  ];

  test("tools/dispatch hit is exactly one schema with defer_loading", async () => {
    let sent: { tools?: Array<{ name?: string; defer_loading?: boolean; allowed_callers?: string[] }> } | undefined;
    await handleMcp(
      { jsonrpc: "2.0", id: "d", method: "tools/dispatch", params: { messages: GH_MSG } },
      {
        base: "http://x",
        key: "k",
        programs: async () => [GH_DISPATCH],
        send: (_id, result) => {
          sent = result as typeof sent;
        },
      },
    );
    expect(sent?.tools).toHaveLength(1);
    expect(sent?.tools?.[0]?.name).toBe("github_pr_bundle");
    expect(sent?.tools?.[0]?.defer_loading).toBe(true);
    expect(sent?.tools?.[0]?.allowed_callers).toEqual(["direct", "code_execution_20260120"]);
  });

  test("tools/dispatch miss is an empty list, not an error", async () => {
    let sent: { tools?: unknown[] } | undefined;
    await handleMcp(
      {
        jsonrpc: "2.0",
        id: "m",
        method: "tools/dispatch",
        params: { messages: [{ role: "user", content: "write a sonnet about the sea" }] },
      },
      {
        base: "http://x",
        key: "k",
        programs: async () => [GH_DISPATCH],
        send: (_id, result) => {
          sent = result as typeof sent;
        },
      },
    );
    expect(sent?.tools).toEqual([]);
  });

  test("tools/dispatch 401 is a JSON-RPC error not an empty catalog", async () => {
    let err: { code?: number; message?: string } | undefined;
    let result: unknown;
    await handleMcp(
      { jsonrpc: "2.0", id: 4, method: "tools/dispatch", params: { messages: GH_MSG } },
      {
        base: "http://x",
        key: "k",
        programs: async () => {
          throw new McpAuthError();
        },
        send: (_id, r) => {
          result = r;
        },
        error: (_id, code, message) => {
          err = { code, message };
        },
      },
    );
    expect(result).toBeUndefined();
    expect(err).toEqual({ code: -32001, message: "unauthorized" });
  });

  test("tools/call surfaces wrap-run deopt reason", async () => {
    const program = {
      id: "p_live",
      version: "v",
      name: "ticket_stretch",
      description: "compiled stretch",
      inputSchema: { type: "object" },
      steps: [],
      returns: { kind: "literal" as const, value: null },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
      manifest: null,
    };
    const prev = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ error: "deopt", reason: "island draft needs an island caller" }), {
          status: 409,
        }),
      { preconnect: prev.preconnect },
    );
    let sent: { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    try {
      await handleMcp(
        { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ticket_stretch", arguments: { id: "T-100" } } },
        {
          base: "http://127.0.0.1:8788",
          key: "k",
          programs: async () => [program],
          send: (_id, result) => {
            sent = result as typeof sent;
          },
        },
      );
    } finally {
      globalThis.fetch = prev;
    }
    expect(sent?.isError).toBe(true);
    expect(sent?.content?.[0]?.text).toContain("island caller");
  });

  test("a stalled wrap endpoint answers with an error instead of wedging the chain", async () => {
    // The wrap-run fetch used to carry no AbortSignal, so an endpoint that
    // accepted the connection and never answered parked the serialized stdio
    // chain — every later request waited forever behind it. With a tiny
    // EDEN_TIMEOUT_MS the abort must surface as the normal isError reply,
    // well before the default horizon.
    const prevTimeout = process.env.EDEN_TIMEOUT_MS;
    const prev = globalThis.fetch;
    process.env.EDEN_TIMEOUT_MS = "50";
    globalThis.fetch = Object.assign(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        }) as never,
      { preconnect: prev.preconnect },
    );
    const program = {
      id: "p_stall",
      version: "v",
      name: "ticket_stretch",
      description: "compiled stretch",
      inputSchema: { type: "object" },
      steps: [],
      returns: { kind: "literal" as const, value: null },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
      manifest: null,
    };
    let sent: { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    try {
      // Bound is EDEN_TIMEOUT_MS=50 on a real AbortSignal — assert the error
      // path, not a wall-clock delta (flake-audit may skew Date.now).
      await handleMcp(
        { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "ticket_stretch", arguments: { id: "T-100" } } },
        {
          base: "http://127.0.0.1:8788",
          key: "k",
          programs: async () => [program],
          send: (_id, result) => {
            sent = result as typeof sent;
          },
        },
      );
    } finally {
      globalThis.fetch = prev;
      if (prevTimeout === undefined) delete process.env.EDEN_TIMEOUT_MS;
      else process.env.EDEN_TIMEOUT_MS = prevTimeout;
    }
    expect(sent?.isError).toBe(true);
    expect(sent?.content?.[0]?.text).toBeTruthy();
  });
});
