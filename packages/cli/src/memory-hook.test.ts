import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse, messagesFromTranscript } from "./memory-hook";
import { respondToHook } from "./hook";
import { AgentMemory, childSessionName, MEMORY_MARK, openMemory } from "../../../src/index";
import { HowToStore, howtoPath } from "../../../src/howto-store";
import { observeToolTraces } from "../../wrap/src/tool-observe";

describe("passive memory hooks", () => {
  // Most tests below point EDEN_HOME / EDEN_MEMORY_DIR at their own dirs and do not restore them.
  const prevHome = process.env.EDEN_HOME;
  const prevMemoryDir = process.env.EDEN_MEMORY_DIR;
  afterEach(() => {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    if (prevMemoryDir === undefined) delete process.env.EDEN_MEMORY_DIR;
    else process.env.EDEN_MEMORY_DIR = prevMemoryDir;
  });

  test("UserPromptSubmit stores a durable fact and later injects it", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-mem-hook");
    const memDir = join(home, "memory");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_MEMORY_DIR = memDir;

    const first = await respondToHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-mem",
      prompt: "Kai's timezone is Pacific",
    });
    expect(first.ok).toBe(true);

    const later = await respondToHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-mem",
      prompt: "What time should I ping Kai about the release?",
    });
    const ctx = (later.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    expect(ctx).toContain(MEMORY_MARK);
    expect(ctx).toMatch(/Pacific/i);

    rmSync(home, { recursive: true, force: true });
  });

  test("chatter is not stored or injected", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-mem-junk");
    const memDir = join(home, "memory");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_MEMORY_DIR = memDir;

    await respondToHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-junk",
      prompt: "ok thanks",
    });
    const later = await respondToHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-junk",
      prompt: "What timezone is Kai in?",
    });
    const ctx = (later.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    expect(ctx).not.toMatch(/ok thanks/i);

    rmSync(home, { recursive: true, force: true });
  });

  test("SessionStart briefs stored constraints", () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-start");
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_MEMORY_DIR = memDir;
    memoryHookResponse({
      hook_event_name: "UserPromptSubmit",
      prompt: "Never commit .env or credentials.json",
    });
    const start = memoryHookResponse({ hook_event_name: "SessionStart" });
    const ctx = (start?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    expect(ctx).toContain(MEMORY_MARK);
    expect(ctx).toMatch(/\.env/i);
    rmSync(memDir, { recursive: true, force: true });
  });

  test("Stop observes a Claude transcript without injecting", () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-stop");
    const trans = join(memDir, "t.jsonl");
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    const userLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: "Always run bun test before you push." },
    });
    writeFileSync(trans, `${userLine}\n`);
    process.env.EDEN_MEMORY_DIR = memDir;
    const stop = memoryHookResponse({ hook_event_name: "Stop", transcript_path: trans });
    expect(stop).toBeNull();
    const later = memoryHookResponse({
      hook_event_name: "UserPromptSubmit",
      prompt: "What should I run before I push?",
    });
    const ctx = (later?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    expect(ctx).toMatch(/bun test/i);
    rmSync(memDir, { recursive: true, force: true });
  });

  test("missing transcript fails open", () => {
    process.env.EDEN_MEMORY_DIR = join(import.meta.dir, "../../.tmp-eden-mem-missing");
    mkdirSync(process.env.EDEN_MEMORY_DIR, { recursive: true });
    expect(messagesFromTranscript("/no/such/transcript.jsonl")).toEqual([]);
    expect(
      memoryHookResponse({ hook_event_name: "PreCompact", transcript_path: "/no/such/transcript.jsonl" }),
    ).toBeNull();
    rmSync(process.env.EDEN_MEMORY_DIR, { recursive: true, force: true });
  });

  test("PostToolUse observes tool failure text into memories.jsonl", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-mem-posttool");
    const memDir = join(home, "memory");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_MEMORY_DIR = memDir;

    const out = await respondToHook({
      hook_event_name: "PostToolUse",
      session_id: "s-post",
      tool_name: "Bash",
      tool_input: { command: "bun test", api_key: "sk-secret-token-value" },
      tool_response: "FAIL src/auth.test.ts\n1 failing\nexit 1",
      is_error: true,
    });
    expect(out.ok).toBe(true);
    expect(out.hookSpecificOutput).toBeUndefined();

    const jsonl = readFileSync(join(memDir, "s-post", "memories.jsonl"), "utf8");
    expect(jsonl).toMatch(/FAIL/);
    expect(jsonl).toMatch(/auth\.test/);
    expect(jsonl).toMatch(/failing/);
    expect(jsonl).toMatch(/exit 1/);
    expect(jsonl).not.toMatch(/sk-secret/);

    rmSync(home, { recursive: true, force: true });
  });

  test("PostToolUse FAIL next to a secret still lands in JSONL", () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-posttool-secret");
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_MEMORY_DIR = memDir;
    const r = memoryHookResponse({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: "FAIL src/auth.test.ts\nexit 1\nsk-abc123XYZ999\nghp_abc123XYZ999",
    });
    expect(r).toBeNull();
    const jsonl = readFileSync(join(memDir, "memories.jsonl"), "utf8");
    expect(jsonl).toMatch(/FAIL/);
    expect(jsonl).toMatch(/auth\.test/);
    expect(jsonl).toMatch(/exit 1/);
    expect(jsonl).not.toMatch(/\bsk-/);
    expect(jsonl).not.toMatch(/\bghp_/);
    rmSync(memDir, { recursive: true, force: true });
  });

  // traces.jsonl goes through IR redact() alone, which let sk-ant-… keys (dashes) and short ghp_ through.
  test("PostToolUse args with an sk-ant key and a short ghp_ reach no store file, traces.jsonl included", () => {
    const memDir = mkdtempSync(join(tmpdir(), "eden-mem-posttool-args-"));
    const prev = process.env.EDEN_MEMORY_DIR;
    const key = "sk-ant-api03-SECRETVALUE99";
    const ghp = "ghp_abc123XYZ999";
    try {
      process.env.EDEN_MEMORY_DIR = memDir;
      memoryHookResponse({
        hook_event_name: "PostToolUse",
        session_id: "s-args-secret",
        tool_name: "Bash",
        tool_input: { command: `./deploy.sh ${key} && gh auth login ${ghp}` },
        tool_response: { stdout: `deployed with ${key}`, stderr: "", exit_code: 0 },
      });
      const files = readdirSync(memDir, { recursive: true, encoding: "utf8" });
      expect(files.map((f) => f.split(/[/\\]/).pop())).toContain("traces.jsonl");
      const leaks = files.filter((f) => {
        let text = "";
        try {
          text = readFileSync(join(memDir, f), "utf8");
        } catch {
          return false; // a directory
        }
        return text.includes("SECRETVALUE99") || text.includes(ghp);
      });
      expect(leaks).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prev;
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  test("PostToolUse without tool_name still stores the result", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-mem-posttool-noname");
    const memDir = join(home, "memory");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_MEMORY_DIR = memDir;

    const out = await respondToHook({
      hook_event_name: "PostToolUse",
      session_id: "s-noname",
      tool_response: "FAIL src/auth.test.ts\n1 failing\nexit 1",
    });
    expect(out.ok).toBe(true);
    expect(out.hookSpecificOutput).toBeUndefined();

    const jsonl = readFileSync(join(memDir, "s-noname", "memories.jsonl"), "utf8");
    expect(jsonl).toMatch(/FAIL/);
    expect(jsonl).toMatch(/auth\.test/);
    expect(jsonl).toMatch(/exit 1/);

    rmSync(home, { recursive: true, force: true });
  });

  test("PostToolUse memoryHookResponse is observe-only (no additionalContext)", () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-posttool-null");
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_MEMORY_DIR = memDir;
    const r = memoryHookResponse({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: "FAIL src/auth.test.ts\nexit 1",
    });
    expect(r).toBeNull();
    rmSync(memDir, { recursive: true, force: true });
  });

  test("PostToolUse pytest fixture persists structured trace beside prose", () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-posttool-trace");
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_MEMORY_DIR = memDir;
    delete process.env.EDEN_HOME;
    const r = memoryHookResponse({
      hook_event_name: "PostToolUse",
      session_id: "s-m9",
      tool_name: "Bash",
      tool_input: { command: "pytest tests/auth/session.test.ts -q" },
      tool_response: "passed auth.ts\nexit 0",
    });
    expect(r).toBeNull();

    const prose = readFileSync(join(memDir, "s-m9", "memories.jsonl"), "utf8");
    expect(prose).toMatch(/Bash|auth\.ts|exit 0/);

    const rows = readFileSync(join(memDir, "s-m9", "traces.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            name?: string;
            args?: { command?: unknown };
            files?: string[];
            exit?: number;
            t?: number;
            order?: number;
          },
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Bash");
    expect(String(rows[0]!.args?.command ?? "")).toMatch(/pytest/);
    expect(rows[0]!.files).toEqual(expect.arrayContaining(["auth.ts"]));
    expect(rows[0]!.exit).toBe(0);
    expect(typeof rows[0]!.t).toBe("number");
    expect(rows[0]!.order).toBe(0);
    expect(existsSync(join(memDir, "traces.jsonl"))).toBe(false);

    memoryHookResponse({
      hook_event_name: "PostToolUse",
      session_id: "s-m9",
      tool_name: "Bash",
      tool_input: { command: "pytest tests/auth/session.test.ts -q" },
      tool_response: "passed auth.ts\nexit 0",
    });
    const again = readFileSync(join(memDir, "s-m9", "traces.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { order?: number });
    expect(again.map((x) => x.order)).toEqual([0, 1]);

    const chatDir = join(import.meta.dir, "../../.tmp-eden-mem-chat-no-trace");
    rmSync(chatDir, { recursive: true, force: true });
    mkdirSync(chatDir, { recursive: true });
    process.env.EDEN_MEMORY_DIR = chatDir;
    memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "Kai timezone is Pacific" });
    expect(existsSync(join(chatDir, "traces.jsonl"))).toBe(false);

    const rootDir = join(import.meta.dir, "../../.tmp-eden-mem-posttool-trace-root");
    rmSync(rootDir, { recursive: true, force: true });
    mkdirSync(rootDir, { recursive: true });
    process.env.EDEN_MEMORY_DIR = rootDir;
    memoryHookResponse({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "pytest tests/auth/session.test.ts -q" },
      tool_response: "passed auth.ts\nexit 0",
    });
    expect(existsSync(join(rootDir, "traces.jsonl"))).toBe(true);
    const rootRow = JSON.parse(readFileSync(join(rootDir, "traces.jsonl"), "utf8").split("\n").filter(Boolean)[0]!);
    expect(rootRow.files).toEqual(expect.arrayContaining(["auth.ts"]));
    expect(rootRow.exit).toBe(0);

    rmSync(memDir, { recursive: true, force: true });
    rmSync(chatDir, { recursive: true, force: true });
    rmSync(rootDir, { recursive: true, force: true });
  });

  test("memory throw does not skip stretch recording", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-mem-throw-stretch");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    const blocked = join(home, "memory-is-a-file");
    writeFileSync(blocked, "not-a-dir");
    process.env.EDEN_MEMORY_DIR = blocked;

    const out = await respondToHook({
      hook_event_name: "PostToolUse",
      session_id: "s-stretch",
      tool_name: "lookupTicket",
      tool_input: { id: "T-100" },
      tool_response: { ok: true },
    });
    expect(out.ok).toBe(true);
    const events = readFileSync(join(home, "runs", "s-stretch.jsonl"), "utf8");
    expect(events.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(events).toMatch(/lookupTicket/);

    rmSync(home, { recursive: true, force: true });
  });

  test("plugin hooks.json lists PostToolUse and SubagentStop", () => {
    const json = JSON.parse(
      readFileSync(join(import.meta.dir, "../../../plugins/eden-memory/hooks/hooks.json"), "utf8"),
    ) as { hooks?: Record<string, unknown> };
    expect(json.hooks?.PostToolUse).toBeTruthy();
    expect(json.hooks?.SubagentStop).toBeTruthy();
  });

  test("plugin hook script observes PostToolUse failure text", () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-plugin-post");
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    const script = join(import.meta.dir, "../../../plugins/eden-memory/scripts/hook.ts");
    const r = spawnSync("bun", [script], {
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_response: "FAIL src/auth.test.ts\nexit 1",
      }),
      encoding: "utf8",
      env: { ...process.env, EDEN_MEMORY_DIR: memDir },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout || "{}")).toEqual({});
    const jsonl = readFileSync(join(memDir, "memories.jsonl"), "utf8");
    expect(jsonl).toMatch(/FAIL/);
    expect(jsonl).toMatch(/auth\.test/);
    rmSync(memDir, { recursive: true, force: true });
  });

  test("SubagentStop does not throw and observes a result", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-mem-subagent");
    const memDir = join(home, "memory");
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    rmSync(home, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_MEMORY_DIR = memDir;
    try {
      const payload = {
        hook_event_name: "SubagentStop",
        session_id: "s-sub",
        result: "FAIL src/auth.test.ts\n1 failing\nexit 1",
      };
      expect(memoryHookResponse(payload)).toBeNull();

      const out = await respondToHook(payload);
      expect(out.ok).toBe(true);
      expect(out.hookSpecificOutput).toBeUndefined();

      const child = childSessionName("s-sub", "sub");
      expect(child).toBe("s-sub--sub");
      const jsonl = readFileSync(join(memDir, child!, "memories.jsonl"), "utf8");
      expect(jsonl.length).toBeGreaterThan(0);
      expect(jsonl).toMatch(/FAIL|auth\.test|failing|exit 1/);
      expect(existsSync(join(memDir, "s-sub", "memories.jsonl"))).toBe(false);

      expect(memoryHookResponse({ hook_event_name: "SubagentStop" })).toBeNull();
      expect(memoryHookResponse({})).toBeNull();
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("SubagentStop with agent_id writes the child suffix jsonl", () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-subagent-agent");
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_MEMORY_DIR = memDir;
    delete process.env.EDEN_HOME;
    try {
      const r = memoryHookResponse({
        hook_event_name: "SubagentStop",
        session_id: "s-parent",
        agent_id: "explore",
        tool_name: "Read",
        tool_response: "FAIL src/auth.test.ts\nexit 1",
      });
      expect(r).toBeNull();

      const child = childSessionName("s-parent", "explore");
      expect(child).toBe("s-parent--explore");
      const jsonl = readFileSync(join(memDir, child!, "memories.jsonl"), "utf8");
      expect(jsonl).toMatch(/Read/);
      expect(jsonl).toMatch(/FAIL|auth\.test|exit 1/);
      expect(existsSync(join(memDir, "s-parent", "memories.jsonl"))).toBe(false);
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  test("SubagentStop fail-opens on cyclic tool_response and an observe throw", async () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-subagent-failopen");
    // respondToHook records the stretch under EDEN_HOME; unset, that is the real ~/.eden (#67).
    const home = mkdtempSync(join(tmpdir(), "eden-mem-failopen-home-"));
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    process.env.EDEN_MEMORY_DIR = memDir;
    process.env.EDEN_HOME = home;
    try {
      const cyclic: Record<string, unknown> = { note: "loop" };
      cyclic.self = cyclic;
      expect(
        memoryHookResponse({
          hook_event_name: "SubagentStop",
          session_id: "s-cycle",
          tool_name: "Bash",
          tool_response: cyclic,
        }),
      ).toBeNull();

      const continued = await respondToHook({
        hook_event_name: "SubagentStop",
        session_id: "s-cycle",
        tool_name: "Bash",
        tool_response: "FAIL src/auth.test.ts\nexit 1",
      });
      expect(continued.ok).toBe(true);
      const child = childSessionName("s-cycle", "sub");
      expect(child).toBe("s-cycle--sub");
      const jsonl = readFileSync(join(memDir, child!, "memories.jsonl"), "utf8");
      expect(jsonl).toMatch(/FAIL|auth\.test|exit 1/);

      const boom = spyOn(AgentMemory.prototype, "observe").mockImplementation(() => {
        throw new Error("m45 observe boom");
      });
      try {
        expect(
          memoryHookResponse({
            hook_event_name: "SubagentStop",
            session_id: "s-boom",
            agent_id: "explore",
            tool_name: "Bash",
            tool_response: "FAIL src/auth.test.ts\nexit 1",
          }),
        ).toBeNull();
      } finally {
        boom.mockRestore();
      }

      const after = memoryHookResponse({
        hook_event_name: "SubagentStop",
        session_id: "s-after",
        agent_id: "explore",
        tool_name: "Read",
        tool_response: "FAIL src/auth.test.ts\nexit 1",
      });
      expect(after).toBeNull();
      const afterChild = childSessionName("s-after", "explore")!;
      expect(readFileSync(join(memDir, afterChild, "memories.jsonl"), "utf8")).toMatch(/FAIL|auth\.test|exit 1/);
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(memDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("plugin hook script finds this checkout and fail-opens on chatter", () => {
    const memDir = join(import.meta.dir, "../../.tmp-eden-mem-plugin");
    rmSync(memDir, { recursive: true, force: true });
    mkdirSync(memDir, { recursive: true });
    const script = join(import.meta.dir, "../../../plugins/eden-memory/scripts/hook.ts");
    const r = spawnSync("bun", [script], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "ok thanks" }),
      encoding: "utf8",
      env: { ...process.env, EDEN_MEMORY_DIR: memDir },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout || "{}")).toEqual({});
    rmSync(memDir, { recursive: true, force: true });
  });

  test("ranking query is the prompt, not the Pacific transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m34-hook-rank-"));
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    process.env.EDEN_MEMORY_DIR = dir;
    delete process.env.EDEN_HOME;
    try {
      const mem = openMemory({ dir });
      mem.remember("CI is GitHub Actions");
      mem.remember("Kai timezone is Pacific");
      for (let i = 0; i < 8; i++) {
        mem.remember(`Kai timezone is Pacific office slot ${i} for standup hours.`);
      }
      mem.close();

      const trans = join(dir, "pacific.jsonl");
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) {
        lines.push(
          JSON.stringify({ type: "user", message: { role: "user", content: `Kai timezone is Pacific note ${i}.` } }),
        );
        lines.push(
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: `Noted Pacific timezone for slot ${i}.` },
          }),
        );
      }
      writeFileSync(trans, `${lines.join("\n")}\n`);

      const bare = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        transcript_path: trans,
        prompt: "What CI do we use?",
      });
      const bareCtx = (bare?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
      expect(bareCtx).not.toMatch(/Pacific/i);

      const later = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        transcript_path: trans,
        prompt: "What GitHub Actions CI do we use?",
      });
      const ctx = (later?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
      expect(ctx).toContain(MEMORY_MARK);
      expect(ctx).toMatch(/GitHub|Actions/i);
      expect(ctx).not.toMatch(/Pacific/i);
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("UserPromptSubmit two serials: labeled Bob, not Alice", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m8-hook-serial-"));
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    process.env.EDEN_MEMORY_DIR = dir;
    delete process.env.EDEN_HOME;
    try {
      const mem = openMemory({ dir });
      mem.remember("1. The chairperson of the committee is Alice.");
      mem.remember("8. The chairperson of the committee is Bob.");
      mem.close();
      const later = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        prompt: "who is the chairperson of the committee",
      });
      const ctx = [
        later?.additional_context,
        (later?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext,
      ]
        .map((x) => String(x ?? ""))
        .join("\n");
      expect(ctx).toContain(MEMORY_MARK);
      expect(ctx).toMatch(/Bob.* \(you said/);
      expect(ctx).not.toMatch(/Alice/);
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Submit does not echo this-turn Clerk; throw fails open to null", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m34-hook-echo-"));
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    process.env.EDEN_MEMORY_DIR = dir;
    delete process.env.EDEN_HOME;
    try {
      const first = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "Auth is Clerk" });
      const ctx = (first?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
      expect(ctx).not.toContain("Clerk");

      const uni = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "café 時區 日本語" });
      expect(uni === null || typeof uni === "object").toBe(true);

      const boom = spyOn(AgentMemory.prototype, "inject").mockImplementation(() => {
        throw new Error("m3.4 hook fail-open");
      });
      try {
        expect(
          memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "What GitHub Actions CI do we use?" }),
        ).toBeNull();
        expect(
          memoryHookResponse({ hook_event_name: "PreCompact", prompt: "What GitHub Actions CI do we use?" }),
        ).toBeNull();
      } finally {
        boom.mockRestore();
      }
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("PreCompact ranking query is the prompt, not the Pacific transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m34-hook-pre-"));
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    process.env.EDEN_MEMORY_DIR = dir;
    delete process.env.EDEN_HOME;
    try {
      const mem = openMemory({ dir });
      mem.remember("CI is GitHub Actions");
      mem.remember("Kai timezone is Pacific");
      for (let i = 0; i < 8; i++) {
        mem.remember(`Kai timezone is Pacific office slot ${i} for standup hours.`);
      }
      mem.close();

      const trans = join(dir, "pacific.jsonl");
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) {
        lines.push(
          JSON.stringify({ type: "user", message: { role: "user", content: `Kai timezone is Pacific note ${i}.` } }),
        );
        lines.push(
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: `Noted Pacific timezone for slot ${i}.` },
          }),
        );
      }
      writeFileSync(trans, `${lines.join("\n")}\n`);

      const pre = memoryHookResponse({
        hook_event_name: "PreCompact",
        transcript_path: trans,
        prompt: "What GitHub Actions CI do we use?",
      });
      const ctx = (pre?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
      expect(ctx).toContain(MEMORY_MARK);
      expect(ctx).toMatch(/GitHub|Actions/i);
      expect(ctx).not.toMatch(/Pacific/i);
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Stop still encodes durable transcript facts for a later turn", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m34-hook-obs-"));
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    process.env.EDEN_MEMORY_DIR = dir;
    delete process.env.EDEN_HOME;
    try {
      const trans = join(dir, "t.jsonl");
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) {
        lines.push(
          JSON.stringify({ type: "user", message: { role: "user", content: `Kai timezone is Pacific note ${i}.` } }),
        );
        lines.push(
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: `Noted Pacific timezone for slot ${i}.` },
          }),
        );
      }
      writeFileSync(trans, `${lines.join("\n")}\n`);

      const stop = memoryHookResponse({ hook_event_name: "Stop", transcript_path: trans });
      expect(stop).toBeNull();

      const later = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        prompt: "What timezone is Kai in?",
      });
      const ctx = (later?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
      expect(ctx).toContain(MEMORY_MARK);
      expect(ctx).toMatch(/Pacific/i);
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("openMemory session writes jsonl under memory/<session>/ and restores ep", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m52-open-"));
    try {
      const a = openMemory({ dir, session: "s-open" });
      a.observe([{ role: "user", content: "Kai timezone is Pacific" }]);
      const first = a.memories();
      expect(first.length).toBeGreaterThan(0);
      const ep1 = first.map((m) => m.ep).find(Boolean);
      expect(ep1).toBeTruthy();
      a.close();
      expect(existsSync(join(dir, "s-open", "memories.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "memories.jsonl"))).toBe(false);

      const b = openMemory({ dir, session: "s-open" });
      b.observe([{ role: "user", content: "CI is GitHub Actions" }]);
      const recs = b.memories();
      const eps = new Set(recs.map((r) => r.ep).filter(Boolean));
      expect(recs.length).toBeGreaterThanOrEqual(2);
      expect(eps.size).toBe(1);
      expect([...eps][0]).toBe(ep1);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unsafe session id cannot leave the memory root", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m52-unsafe-"));
    try {
      const mem = openMemory({ dir, session: "../escape" });
      mem.remember("CI is GitHub Actions");
      mem.close();
      expect(existsSync(join(dir, "memories.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "escape", "memories.jsonl"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session ../etc cannot write outside the memory dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m52-etc-"));
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    process.env.EDEN_MEMORY_DIR = dir;
    delete process.env.EDEN_HOME;
    try {
      const marker = "CI is GitHub Actions m52-etc-sentinel";
      const mem = openMemory({ dir, session: "../etc" });
      mem.remember(marker);
      mem.close();
      expect(existsSync(join(dir, "memories.jsonl"))).toBe(true);
      expect(readFileSync(join(dir, "memories.jsonl"), "utf8")).toMatch(/m52-etc-sentinel/);
      const outside = join(dir, "..", "etc", "memories.jsonl");
      if (existsSync(outside)) {
        expect(readFileSync(outside, "utf8")).not.toMatch(/m52-etc-sentinel/);
      }

      memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        session_id: "../etc",
        prompt: "Kai timezone is Pacific m52-etc-hook-sentinel",
      });
      expect(readFileSync(join(dir, "memories.jsonl"), "utf8")).toMatch(/m52-etc-hook-sentinel|Pacific/i);
      if (existsSync(outside)) {
        expect(readFileSync(outside, "utf8")).not.toMatch(/m52-etc-hook-sentinel/);
      }
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same session_id restores ep across two hook openMemory spawns", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m52-hook-ep-"));
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    process.env.EDEN_MEMORY_DIR = dir;
    delete process.env.EDEN_HOME;
    const session_id = "s-ep-restore";
    try {
      memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        session_id,
        prompt: "Kai timezone is Pacific",
      });
      memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        session_id,
        prompt: "CI is GitHub Actions",
      });
      const jsonl = readFileSync(join(dir, session_id, "memories.jsonl"), "utf8");
      const recs = jsonl
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { text?: string; ep?: string });
      expect(recs.length).toBeGreaterThanOrEqual(2);
      const eps = new Set(recs.map((r) => r.ep).filter(Boolean));
      expect(eps.size).toBe(1);

      const mem = openMemory({ dir, session: session_id });
      const notes = mem.notesFor("What GitHub Actions CI timezone is Kai in?");
      const blob = notes.map((n) => n.text).join("\n");
      expect(blob).toMatch(/Pacific/i);
      expect(blob).toMatch(/GitHub|Actions/i);
      mem.close();
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hook sessionID alias writes the session jsonl; processMemory child id uses childSessionName", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m52-alias-"));
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    process.env.EDEN_MEMORY_DIR = dir;
    delete process.env.EDEN_HOME;
    try {
      memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        sessionID: "sCamel",
        prompt: "Kai timezone is Pacific",
      });
      expect(existsSync(join(dir, "sCamel", "memories.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "memories.jsonl"))).toBe(false);

      const src = readFileSync(join(import.meta.dir, "../../../src/index.ts"), "utf8");
      const body = src.match(/export function processMemory\(\)[\s\S]*?\n\}/)?.[0] ?? "";
      expect(body).toBeTruthy();
      const isolated =
        body.match(/if \(process\.argv\.some\(\(a\) => a\.endsWith\("\.test\.ts"\)\)\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
      expect(isolated).toBeTruthy();
      expect(isolated).not.toMatch(/session\s*:/);
      expect(body).toMatch(/EDEN_MEMORY_CHILD/);
      expect(body).toMatch(/childSessionName\(parent,\s*childId\)/);
    } finally {
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const M13_SESSION = "sess-m132-abc";
const M13_CWD = "/tmp/eden-m132-cwd";
const M13_EMAIL = "kai@example.com";
const M13_SQLITE = "Use sqlite.";
const M13_SQLITE_Q = "What sqlite database do we use?";
const M13_CLERK = "Auth is Clerk";

function m13WithEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): T | Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out && typeof (out as Promise<T>).then === "function") {
      return (out as Promise<T>).finally(restore);
    }
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}

function m13HookCtx(out: Record<string, unknown> | null): string {
  return [
    out?.additional_context,
    (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext,
  ]
    .map((x) => String(x ?? ""))
    .join("\n");
}

function m13JsonlContents(root: string): string {
  const names = new Set([
    "memories.jsonl",
    "semantic.jsonl",
    "gists.jsonl",
    "howto.jsonl",
    "howtos.jsonl",
    "traces.jsonl",
  ]);
  const chunks: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (names.has(ent.name) || /^howto.*\.jsonl$/i.test(ent.name)) {
        try {
          chunks.push(readFileSync(p, "utf8"));
        } catch {}
      }
    }
  };
  walk(root);
  return chunks.join("\n");
}

describe("M13 honest off switch (hook)", () => {
  test("off: 0/off hook returns null, does not persist, agent continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m13-hook-off-"));
    // respondToHook records the stretch under EDEN_HOME; unset, that is the real ~/.eden (#67).
    const home = mkdtempSync(join(tmpdir(), "eden-m13-hook-off-home-"));
    try {
      for (const value of ["0", "off"]) {
        await m13WithEnv({ EDEN_MEMORY: value, EDEN_MEMORY_DIR: dir, EDEN_HOME: home }, async () => {
          let out: Record<string, unknown> | null = null;
          expect(() => {
            out = memoryHookResponse({
              hook_event_name: "UserPromptSubmit",
              session_id: "s-off",
              prompt: M13_SQLITE,
            });
          }).not.toThrow();
          expect(out).toBeNull();
          expect(JSON.stringify(out ?? {})).not.toMatch(/403/);

          const later = memoryHookResponse({
            hook_event_name: "UserPromptSubmit",
            session_id: "s-off",
            prompt: M13_SQLITE_Q,
          });
          expect(later).toBeNull();
          expect(m13HookCtx(later)).not.toContain(MEMORY_MARK);

          await expect(
            respondToHook({ hook_event_name: "UserPromptSubmit", session_id: "s-off", prompt: M13_SQLITE_Q }),
          ).resolves.toEqual({ ok: true });
        });
      }
      expect(m13JsonlContents(dir)).not.toMatch(/sqlite/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("readonly: Submit about sqlite still injects the fact; Auth is Clerk is not persisted", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m13-hook-ro-"));
    try {
      m13WithEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        const mem = openMemory({ dir });
        mem.remember(M13_SQLITE);
        mem.close();
      });
      for (const value of ["readonly", "read-only", "ro"]) {
        m13WithEnv({ EDEN_MEMORY: value, EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
          const clerk = memoryHookResponse({
            hook_event_name: "UserPromptSubmit",
            prompt: M13_CLERK,
          });
          expect(clerk === null || typeof clerk === "object").toBe(true);
          expect(m13HookCtx(clerk)).not.toContain("Clerk");

          const later = memoryHookResponse({
            hook_event_name: "UserPromptSubmit",
            prompt: M13_SQLITE_Q,
          });
          const ctx = m13HookCtx(later);
          expect(ctx).toContain(MEMORY_MARK);
          expect(ctx).toMatch(/sqlite.* \(you said/i);
        });
      }
      expect(m13JsonlContents(dir)).not.toMatch(/Clerk/i);
      expect(m13JsonlContents(dir)).toMatch(/sqlite/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("on: unset/1/on encode and inject sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m13-hook-on-"));
    try {
      for (const value of [undefined, "1", "on"] as const) {
        m13WithEnv({ EDEN_MEMORY: value, EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
          const mem = openMemory({ dir });
          mem.remember(M13_SQLITE);
          mem.close();
          const later = memoryHookResponse({
            hook_event_name: "UserPromptSubmit",
            prompt: M13_SQLITE_Q,
          });
          const ctx = m13HookCtx(later);
          expect(ctx).toContain(MEMORY_MARK);
          expect(ctx).toMatch(/sqlite.* \(you said/i);
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Stop scrub: session_id, cwd, email absent from jsonl files; secrets still redacted", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m13-hook-scrub-"));
    const trans = join(dir, "t.jsonl");
    try {
      writeFileSync(
        trans,
        `${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content:
              `Use sqlite. Always email ${M13_EMAIL}. Working in ${M13_CWD}. Session ${M13_SESSION}. Token ` +
              `sk-abc123XYZ999 ghp_abc123XYZ999`,
          },
        })}\n`,
      );
      m13WithEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        const stop = memoryHookResponse({
          hook_event_name: "Stop",
          session_id: M13_SESSION,
          cwd: M13_CWD,
          transcript_path: trans,
          prompt: `Ping ${M13_EMAIL} in ${M13_CWD} about ${M13_SESSION}`,
        });
        expect(stop).toBeNull();
      });
      const blob = m13JsonlContents(dir);
      expect(blob).not.toContain(M13_SESSION);
      expect(blob).not.toContain(M13_CWD);
      expect(blob).not.toContain(M13_EMAIL);
      expect(blob).not.toMatch(/\bsk-/);
      expect(blob).not.toMatch(/\bghp_/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fail-open: inject throw still null; off is identity not 403", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m13-hook-fo-"));
    try {
      m13WithEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        const boom = spyOn(AgentMemory.prototype, "inject").mockImplementation(() => {
          throw new Error("m13 hook fail-open");
        });
        try {
          expect(memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: M13_SQLITE_Q })).toBeNull();
          expect(memoryHookResponse({ hook_event_name: "PreCompact", prompt: M13_SQLITE_Q })).toBeNull();
        } finally {
          boom.mockRestore();
        }
      });
      m13WithEnv({ EDEN_MEMORY: "0", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        const body = { hook_event_name: "UserPromptSubmit", prompt: M13_SQLITE_Q };
        let out: unknown;
        expect(() => {
          out = memoryHookResponse(body);
        }).not.toThrow();
        expect(out).toBeNull();
        expect(JSON.stringify(out ?? {})).not.toMatch(/403/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const M14_PYTEST = "pytest tests/auth/session.test.ts -q";
const M14_FLAKE = "the flake is in auth.ts";
const M14_SESSION = "s-m14-hook";

function m14PytestWindow(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_pytest",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: M14_PYTEST }) },
        },
        {
          id: "call_read",
          type: "function",
          function: { name: "Read", arguments: JSON.stringify({ path: "src/login.ts" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_pytest", content: "collected 1 item\nauth.ts touched\nexit 0" },
    { role: "tool", tool_call_id: "call_read", content: "ok\nexit 0" },
  ];
}

describe("M14.4 hook Start/Submit share wrap-written how-to", () => {
  test("wrap observe+sleep then Start stays empty-cue; Submit injects same howto id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m14-hook-"));
    try {
      await m13WithEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, async () => {
        const mem = openMemory({ dir, session: M14_SESSION });
        observeToolTraces(mem, m14PytestWindow());
        await mem.sleep();
        mem.close();

        expect(howtoPath(dir)).toBe(join(dir, "howto.jsonl"));
        expect(existsSync(join(dir, "howto.jsonl"))).toBe(true);
        expect(existsSync(join(dir, M14_SESSION, "howto.jsonl"))).toBe(false);
        const stored = new HowToStore(dir).latest("auth pytest flake", 5)[0];
        expect(stored?.id).toBeTruthy();

        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: M14_SESSION });
        const startHay = m13HookCtx(start);
        expect(`${startHay}\n${JSON.stringify(start ?? {})}`).not.toMatch(/verify:/);
        expect(new HowToStore(dir).latest("auth pytest flake", 5).some((r) => r.id === stored!.id)).toBe(true);

        const submit = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: M14_SESSION,
          prompt: M14_FLAKE,
        });
        const submitHay = `${m13HookCtx(submit)}\n${JSON.stringify(submit ?? {})}`;
        expect(submitHay).toMatch(/verify: .*\(from a tool result/);
        expect(submitHay).toMatch(/auth\.ts/);
        expect(submitHay).toMatch(/pytest/i);
        expect(new HowToStore(dir).latest("auth pytest flake", 5).some((r) => r.id === stored!.id)).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("chat-only hook Submit injects Clerk with no procedure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m14-hook-chat-"));
    try {
      await m13WithEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, async () => {
        const mem = openMemory({ dir });
        mem.observe([
          { role: "user", content: M13_CLERK },
          { role: "assistant", content: "Understood, we use Clerk for auth." },
        ]);
        await mem.sleep();
        mem.close();
        expect(new HowToStore(dir).latest("anything", 5)).toEqual([]);

        const submit = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "what is auth using?" });
        const hay = `${m13HookCtx(submit)}\n${JSON.stringify(submit ?? {})}`;
        expect(hay).toMatch(/Clerk/i);
        expect(hay).not.toMatch(/verify:/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const M17_ICL_LONG =
  "The movie review is glowing and mentions every scene in detail about the protagonist and the " +
  "village festival that lasted three nights under lanterns while the orchestra played until dawn and " +
  "the crowd wept. label: 28 extra filler words to exceed four hundred characters of extractDurable " +
  "tax so we can see if the whole exemplar is dropped or chopped into pieces by the allow-list " +
  "pipeline that is still the only encode path.";

describe("M17 hook encode lanes", () => {
  test("UserPromptSubmit stores whole ICL shot and later injects label: 28", () => {
    expect(M17_ICL_LONG.length).toBeGreaterThan(400);
    const dir = mkdtempSync(join(tmpdir(), "eden-m17-hook-"));
    try {
      m13WithEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: M17_ICL_LONG, session_id: "s-m17" });
        const jsonl = readFileSync(join(dir, "s-m17", "memories.jsonl"), "utf8");
        expect(jsonl).toContain(M17_ICL_LONG);
        expect(jsonl).toMatch(/"lane":"icl"/);
        const later = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          prompt: "The movie review. label:",
          session_id: "s-m17",
        });
        expect(m13HookCtx(later)).toMatch(/label:\s*28/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M38.2 hook honors an omitted packet; Start still briefs", () => {
  test("what's 2+2? Submit/PreCompact are null; SessionStart after observe+sleep briefs pins or gists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m38-hook-"));
    try {
      await m13WithEnv(
        {
          EDEN_MEMORY: "on",
          EDEN_MEMORY_DIR: dir,
          EDEN_HOME: undefined,
          EDEN_KNOW: "0",
          EDEN_MEMORY_MIN: undefined,
        },
        async () => {
          const mem = openMemory({ dir, session: "s-m38" });
          mem.remember("Use sqlite.");
          mem.observe([{ role: "user", content: "Always run tests before committing." }]);
          await mem.sleep({ session: "s-m38" });
          mem.close();

          const submit = memoryHookResponse({
            hook_event_name: "UserPromptSubmit",
            session_id: "s-m38",
            prompt: "what's 2+2?",
          });
          expect(submit).toBeNull();
          expect(m13HookCtx(submit)).not.toContain(MEMORY_MARK);

          const pre = memoryHookResponse({
            hook_event_name: "PreCompact",
            session_id: "s-m38",
            prompt: "what's 2+2?",
          });
          expect(pre).toBeNull();
          expect(m13HookCtx(pre)).not.toContain(MEMORY_MARK);

          const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: "s-m38" });
          const ctx = m13HookCtx(start);
          expect(ctx).toContain(MEMORY_MARK);
          expect(ctx).toMatch(/Rule you set: |\(from a summary of earlier work/);
          expect(ctx).not.toMatch(/\(you said/);
          expect(ctx).toMatch(/Always run tests before committing/i);
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
