import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { familyId, matchPrefix, parseNamedCli } from "@eden/core";
import {
  appendJsonl,
  edenHome,
  ensureHome,
  eventsPath,
  liveToolsPath,
  outboxPath,
  readJson,
} from "./home";

type HookIn = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  permissionDecision?: string;
};

type LiveTool = { name: string; seen: string[]; required_k: number };

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c as Buffer));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (process.stdin.isTTY) resolve("{}");
  });
}

function cliFamily(name: string, args: Record<string, unknown>): string {
  if (name === "Bash" || name === "bash") {
    const parsed = parseNamedCli(String(args.command ?? ""));
    if (parsed) return familyId(parsed);
    const cmd = String(args.command ?? "");
    return cmd.trim().split(/\s+/)[0]?.replace(/.*\//, "") || "Bash";
  }
  return name;
}

function fireDrain(): void {
  const cli = join(import.meta.dir, "cli.ts");
  Bun.spawn(["bun", cli, "drain"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

export async function runHook(): Promise<void> {
  const raw = await readStdin();
  let input: HookIn = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    process.stdout.write("{}\n");
    return;
  }
  const event = input.hook_event_name || "PreToolUse";
  const runId = input.session_id || "unknown";
  ensureHome();

  if (event === "PreToolUse") {
    const live = readJson<LiveTool[]>(liveToolsPath(), []);
    const statePath = eventsPath(runId) + ".seen";
    const seen = readJson<string[]>(statePath, []);
    const incoming = cliFamily(input.tool_name || "", input.tool_input || {});
    const decision = matchPrefix(live, seen, incoming);
    seen.push(incoming);
    writeFileSync(statePath, JSON.stringify(seen));
    if (decision.action === "deny") {
      const already = readJson<{ steered?: boolean }>(eventsPath(runId) + ".steer", {});
      if (already.steered) {
        process.stdout.write("{}\n");
        return;
      }
      writeFileSync(eventsPath(runId) + ".steer", JSON.stringify({ steered: true }));
      process.stdout.write(
        JSON.stringify({
          decision: "deny",
          reason: decision.reason,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: decision.reason,
          },
          systemMessage: `Eden: call ${decision.tool} instead of this stretch.`,
        }) + "\n",
      );
      return;
    }
    process.stdout.write("{}\n");
    return;
  }

  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    const statePath = eventsPath(runId) + ".seen";
    const seen = readJson<string[]>(statePath, []);
    appendJsonl(eventsPath(runId), {
      event_id: crypto.randomUUID(),
      hook: event,
      seq: seen.length,
      name: input.tool_name,
      args: input.tool_input || {},
      command: (input.tool_input as { command?: string })?.command,
      ok: event !== "PostToolUseFailure",
      ts: Date.now(),
    });
    process.stdout.write("{}\n");
    return;
  }

  if (event === "Stop" || event === "UserPromptSubmit") {
    appendJsonl(outboxPath(), {
      run_id: runId,
      kind: event === "Stop" ? "stretch_end" : "turn_split",
      flushed: false,
      ts: Date.now(),
    });
    if (event === "Stop") fireDrain();
    process.stdout.write("{}\n");
    return;
  }

  if (event === "SessionStart") {
    const knockPath = join(edenHome(), "knock.json");
    const knock = readJson<{ message?: string; shown?: number }>(knockPath, {});
    let msg: string | undefined;
    const shown = knock.shown ?? 0;
    if (knock.message && shown < 2) {
      msg = `Eden: a draft tool is ready. Run \`eden open\` or \`eden reject\`.\n${knock.message}`;
      writeFileSync(knockPath, JSON.stringify({ ...knock, shown: shown + 1 }));
    }
    fireDrain();
    process.stdout.write(JSON.stringify(msg ? { systemMessage: msg } : {}) + "\n");
    return;
  }

  process.stdout.write("{}\n");
}

if (import.meta.main) {
  await runHook();
}
