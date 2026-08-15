import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { familyId, parseNamedCli, rewriteBash, compactStdout, compactReadOutput } from "@eden/core";
import {
  appendJsonl,
  edenHome,
  ensureHome,
  eventsPath,
  liveToolsPath,
  outboxPath,
  readJson,
} from "./home";

export type HookIn = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  permissionDecision?: string;
  tool_response?: unknown;
  tool_output?: unknown;
  response?: unknown;
};

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

function spawnDrainProc() {
  const exe = process.execPath || "";
  return /(?:^|\/)eden$/.test(exe)
    ? Bun.spawn([exe, "drain"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    : Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "drain"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

function spawnDrain(): void {
  try {
    spawnDrainProc().unref();
  } catch {
    /* server may be down */
  }
}

async function drainNow(): Promise<void> {
  try {
    const proc = spawnDrainProc();
    await proc.exited;
  } catch {
    /* server may be down */
  }
}

function stdoutFromResponse(raw: unknown): { stdout: string; stderr: string; interrupted: boolean; isImage: boolean } | null {
  if (raw == null) return null;
  if (typeof raw === "string") return { stdout: raw, stderr: "", interrupted: false, isImage: false };
  if (typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.stdout === "string" || typeof o.stderr === "string") {
    return {
      stdout: String(o.stdout ?? ""),
      stderr: String(o.stderr ?? ""),
      interrupted: Boolean(o.interrupted),
      isImage: Boolean(o.isImage),
    };
  }
  if (typeof o.content === "string") {
    return { stdout: o.content, stderr: "", interrupted: false, isImage: false };
  }
  if (Array.isArray(o.content)) {
    const text = o.content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c) return String((c as { text: unknown }).text ?? "");
        return "";
      })
      .join("");
    if (text) return { stdout: text, stderr: "", interrupted: false, isImage: false };
  }
  if (o.file && typeof o.file === "object") {
    const f = o.file as Record<string, unknown>;
    if (typeof f.content === "string") return { stdout: f.content, stderr: "", interrupted: false, isImage: false };
  }
  return null;
}

function bashOutput(stdout: string, stderr: string, interrupted = false) {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: {
        stdout,
        stderr,
        interrupted,
        isImage: false,
      },
    },
  };
}

export async function respondToHook(input: HookIn): Promise<Record<string, unknown>> {
  try {
    return await respondToHookInner(input);
  } catch {
    return {};
  }
}

async function respondToHookInner(input: HookIn): Promise<Record<string, unknown>> {
  const event = input.hook_event_name || "PreToolUse";
  const runId = input.session_id || "unknown";
  ensureHome();

  if (event === "PreToolUse") {
    const statePath = eventsPath(runId) + ".seen";
    const seen = readJson<string[]>(statePath, []);
    const incoming = cliFamily(input.tool_name || "", input.tool_input || {});
    seen.push(incoming);
    writeFileSync(statePath, JSON.stringify(seen));

    const name = input.tool_name || "";
    if (name === "Bash" || name === "bash") {
      const original = String((input.tool_input as { command?: string } | undefined)?.command ?? "");
      appendJsonl(eventsPath(runId), {
        event_id: crypto.randomUUID(),
        hook: event,
        seq: seen.length,
        name,
        args: input.tool_input || {},
        command: original,
        ok: true,
        ts: Date.now(),
      });
      const rewritten = rewriteBash(original);
      if (rewritten.changed) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { ...input.tool_input, command: rewritten.command },
          },
        };
      }
    }
    return {};
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
    if (event === "PostToolUseFailure") return {};
    const extracted = stdoutFromResponse(input.tool_response ?? input.tool_output ?? input.response);
    if (!extracted) return {};
    const name = input.tool_name || "";
    if (name === "Read") {
      const filePath = String((input.tool_input as { file_path?: string } | undefined)?.file_path ?? "");
      const packed = compactReadOutput(filePath, extracted.stdout);
      if (packed.stdout === extracted.stdout) return {};
      return bashOutput(packed.stdout, extracted.stderr, extracted.interrupted);
    }
    if (name === "Bash" || name === "bash") {
      const command = String((input.tool_input as { command?: string } | undefined)?.command ?? "");
      const packed = compactStdout(command, extracted.stdout);
      if (packed.stdout === extracted.stdout) return {};
      return bashOutput(packed.stdout, extracted.stderr, extracted.interrupted);
    }
    const packed = compactStdout(name, extracted.stdout);
    if (packed.stdout === extracted.stdout) return {};
    return bashOutput(packed.stdout, extracted.stderr, extracted.interrupted);
  }

  if (event === "Stop" || event === "UserPromptSubmit") {
    appendJsonl(outboxPath(), {
      run_id: runId,
      kind: event === "Stop" ? "stretch_end" : "turn_split",
      flushed: false,
      ts: Date.now(),
    });
    if (event === "Stop") spawnDrain();
    return {};
  }

  if (event === "SessionStart") {
    try {
      if (existsSync(outboxPath()) || existsSync(liveToolsPath())) await drainNow();
    } catch {
      /* server may be down */
    }
    const knockPath = join(edenHome(), "knock.json");
    const knock = readJson<{ message?: string; shown?: number }>(knockPath, {});
    const shown = knock.shown ?? 0;
    if (knock.message && shown < 2 && process.env.EDEN_KNOCK !== "0") {
      writeFileSync(knockPath, JSON.stringify({ ...knock, shown: shown + 1 }));
      return {
        systemMessage: `Eden: a draft tool is ready. Run \`eden open\` or \`eden reject\`.\n${knock.message}`,
      };
    }
    return {};
  }

  return {};
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
  const out = await respondToHook(input);
  process.stdout.write(JSON.stringify(out) + "\n");
}

if (import.meta.main) {
  await runHook();
}
