import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { edenHome, ensureHome, appendJsonl, readConfig, readJson, withFileLock, outboxPath, wrapPlaneUrl } from "./home";
import { redact, isStretchEnd, inDistribution } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";

export type HookIn = {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_output?: unknown;
};

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c as Buffer));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (process.stdin.isTTY) resolve("{}");
  });
}

export async function runHook(): Promise<void> {
  const raw = await readStdin();
  let body: HookIn = {};
  try {
    body = JSON.parse(raw || "{}") as HookIn;
  } catch {
    body = {};
  }
  const out = respondToHook(body);
  process.stdout.write(JSON.stringify(out));
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => !!x);
}

function flushSession(session: string, events: Array<Record<string, unknown>>): void {
  const cfg = readConfig();
  if (!cfg || events.length < 2) return;
  const path = join(edenHome(), "runs", `${session}.jsonl`);
  const flushedIds = events.map((e) => String(e.id ?? ""));
  const first = events[0]!;
  const t0 = Number(first.ts ?? Date.now());
  const t1 = Number(events.at(-1)?.ts ?? t0);
  const islandish = events.filter((e) => /draft|reply|generate|summarize|compose|llm/i.test(String(e.name))).length;
  const naiveLlm = Math.max(islandish, events.length);
  void fetch(`${wrapPlaneUrl(cfg.base_url)}/v1/traces`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.api_key}`, "content-type": "application/json" },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      events,
      input: first.args ?? {},
      llmCalls: naiveLlm,
      duration_ms: Math.max(0, t1 - t0),
      cost_cents: naiveLlm,
      complete: true,
    }),
  })
    .then((r) => {
      if (r.ok) withFileLock(`${path}.lock`, () => applyFlushTruncate(path, flushedIds));
    })
    .catch(() => undefined);
}

export function applyFlushTruncate(path: string, flushedIds: string[]): void {
  const drop = new Set(flushedIds.filter(Boolean));
  const current = readJsonl(path);
  const rest = drop.size ? current.filter((e) => !drop.has(String(e.id ?? ""))) : [];
  writeFileSync(path, rest.length ? rest.map((e) => JSON.stringify(e)).join("\n") + "\n" : "");
}

export function respondToHook(body: HookIn): Record<string, unknown> {
  ensureHome();
  const session = body.session_id || "local";
  const name = body.tool_name;
  if (body.hook_event_name === "PostToolUse" && name) {
    const event = redact({
      id: crypto.randomUUID(),
      name,
      args: body.tool_input ?? {},
      result: body.tool_response ?? body.tool_output,
      ok: (body as { is_error?: boolean }).is_error !== true,
      ts: Date.now(),
    }) as Record<string, unknown>;
    const path = join(edenHome(), "runs", `${session}.jsonl`);
    withFileLock(`${path}.lock`, () => appendJsonl(path, event));
    const events = readJsonl(path);
    if (events.length >= 2 && isStretchEnd(name)) {
      flushSession(session, events);
    }
  }
  if (body.hook_event_name === "Stop" || body.hook_event_name === "SessionEnd") {
    withFileLock(`${outboxPath()}.lock`, () =>
      appendJsonl(outboxPath(), { run_id: session, kind: "stretch_end", ts: Date.now() }),
    );
    const path = join(edenHome(), "runs", `${session}.jsonl`);
    const events = readJsonl(path);
    if (events.length >= 2) flushSession(session, events);
  }
  const live = readJson<
    Array<{ name: string; sequence?: string[]; envelope?: { inputs?: Record<string, unknown[]> } }>
  >(join(edenHome(), "live-tools.json"), []);
  if (body.hook_event_name === "PreToolUse" && name) {
    if (live.some((t) => t.name === name)) return { ok: true };
    const hits = live
      .filter((t) => (t.sequence ?? [])[0] === name)
      .sort((a, b) => (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0));
    const hit = hits[0];
    if (hit) {
      if (hit.envelope?.inputs) {
        const probe = {
          contract: { envelope: hit.envelope, allowExact: false, witnesses: 1, minLlmReduction: 2 },
        } as StretchProgram;
        if (!inDistribution(probe, body.tool_input ?? {})) return { ok: true };
      }
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Use the Eden compiled tool ${hit.name} via MCP instead of ${name}.`,
        },
      };
    }
  }
  return { ok: true };
}
