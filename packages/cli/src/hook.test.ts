import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { respondToHook } from "./hook";

const cli = join(import.meta.dir, "cli.ts");

describe("hook hot path", () => {
  test("allow path does not call the network", () => {
    const env = { ...process.env, EDEN_HOME: join(import.meta.dir, "../../.tmp-eden-test") };
    const started = Date.now();
    const r = spawnSync("bun", [cli, "hook"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "t1",
        tool_name: "Read",
        tool_input: { file_path: "a.ts" },
      }),
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout || "{}")).toEqual({});
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("always-better hook", () => {
  const home = join("/tmp", `eden-hook-${Date.now()}`);
  mkdirSync(join(home, "runs"), { recursive: true });

  test("never denies gh.api even when a live tool exists", async () => {
    process.env.EDEN_HOME = home;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(home, "live-tools.json"),
      JSON.stringify([{ name: "github_pr_bundle", seen: ["gh.api"], required_k: 1 }]),
    );
    const out = await respondToHook({
      hook_event_name: "PreToolUse",
      session_id: "deny-check",
      tool_name: "Bash",
      tool_input: { command: "gh api repos/KaiavN/Eden/pulls/170" },
    });
    const decision = (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision;
    expect(decision === "deny").toBe(false);
    expect(JSON.stringify(out)).not.toContain("permissionDecision\":\"deny");
  });

  test("rewrites a for-loop via updatedInput", async () => {
    process.env.EDEN_HOME = home;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(home, "live-tools.json"), "[]");
    const cmd =
      "for n in 170 169; do gh api repos/KaiavN/Eden/pulls/$n; gh api repos/KaiavN/Eden/pulls/$n/reviews; done";
    const out = await respondToHook({
      hook_event_name: "PreToolUse",
      session_id: "loop",
      tool_name: "Bash",
      tool_input: { command: cmd },
    });
    const updated = (out as { hookSpecificOutput?: { updatedInput?: { command?: string } } }).hookSpecificOutput
      ?.updatedInput?.command;
    expect(updated).toBeTruthy();
    expect(updated === cmd).toBe(false);
    expect(updated).toContain("wait");
    expect(updated).toContain("&");
    expect(updated).toContain("gh api");
    expect(updated).toContain("cat ");
    expect(updated).not.toContain("fulfill");
    expect(updated).not.toContain(" play ");
  });

  test("rewrites a live-bundle loop to play, never deny, never fulfill", async () => {
    process.env.EDEN_HOME = home;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(home, "live-tools.json"),
      JSON.stringify([{ name: "github_pr_bundle", seen: ["gh.api"], required_k: 1 }]),
    );
    const cmd =
      "for n in 170 169; do gh api repos/KaiavN/Eden/pulls/$n; gh api repos/KaiavN/Eden/pulls/$n/reviews; done";
    const out = await respondToHook({
      hook_event_name: "PreToolUse",
      session_id: "play-loop",
      tool_name: "Bash",
      tool_input: { command: cmd },
    });
    const updated = (out as { hookSpecificOutput?: { updatedInput?: { command?: string } } }).hookSpecificOutput
      ?.updatedInput?.command;
    const decision = (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision;
    expect(decision === "deny").toBe(false);
    expect(updated).toContain("play github_pr_bundle --issues 170,169");
    expect(updated).not.toContain("fulfill");
    expect(updated).not.toContain("wait");
  });

  test("PostToolUse leaves gh api JSON intact and densifies bun test", async () => {
    process.env.EDEN_HOME = home;
    const fat = JSON.stringify({
      number: 12,
      title: "Cannot deploy widget 12",
      state: "open",
      body: "x".repeat(4000),
      user: { login: "octocat" },
      head: { sha: "abc" },
    });
    const gh = await respondToHook({
      hook_event_name: "PostToolUse",
      session_id: "post",
      tool_name: "Bash",
      tool_input: { command: "gh api repos/acme/app/pulls/12" },
      tool_response: { stdout: fat, stderr: "", interrupted: false, isImage: false },
    });
    expect(JSON.stringify(gh)).not.toContain("updatedToolOutput");
    const testDump =
      Array.from({ length: 40 }, (_, i) => `(pass) some.test.ts > case ${i} [1ms]`).join("\n") +
      "\n  40 pass\n  0 fail\nRan 40 tests across 8 files. [143.00ms]\n";
    const out = await respondToHook({
      hook_event_name: "PostToolUse",
      session_id: "post-test",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { stdout: testDump, stderr: "", interrupted: false, isImage: false },
    });
    const stdout = (out as { hookSpecificOutput?: { updatedToolOutput?: { stdout?: string } } }).hookSpecificOutput
      ?.updatedToolOutput?.stdout;
    expect(stdout).toBeTruthy();
    expect(stdout!.length).toBeLessThan(80);
    expect(stdout).toContain("40 pass");
  });

  test("SessionStart does not advertise MCP tools", async () => {
    process.env.EDEN_HOME = home;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(home, "live-tools.json"),
      JSON.stringify([{ name: "github_pr_bundle", seen: ["gh.api"], required_k: 1 }]),
    );
    const out = await respondToHook({
      hook_event_name: "SessionStart",
      session_id: "start",
    });
    expect(JSON.stringify(out)).not.toContain("hosted tools");
    expect(JSON.stringify(out)).not.toContain("github_pr_bundle");
  });

  test("hook fail-open returns {} on invalid input shape", async () => {
    process.env.EDEN_HOME = home;
    const out = await respondToHook({
      hook_event_name: "PreToolUse",
      session_id: "bad",
      tool_name: "Bash",
      tool_input: null as unknown as Record<string, unknown>,
    });
    expect(out).toEqual({});
  });
});
