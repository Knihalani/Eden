import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { eventsPath, liveToolsPath, outboxPath, readConfig, ensureHome, edenHome, resolveApiKey, withFileLock, wrapPlaneUrl, sitePlaneUrl } from "./home";

function ingestible(row: Record<string, unknown>): boolean {
  const hook = String(row.hook || "");
  if (hook === "PreToolUse") return false;
  if (hook === "SessionStart" || hook === "Stop" || hook === "UserPromptSubmit") return false;
  return Boolean(row.name);
}

type OutboxRow = { run_id?: string; kind?: string; ts?: number };

export function lastOutboxKind(outboxText: string, runId: string): string | undefined {
  let last: string | undefined;
  for (const line of outboxText.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as OutboxRow;
      if (row.run_id === runId && row.kind) last = row.kind;
    } catch {
      /* skip */
    }
  }
  return last;
}

/** Stop → true. turn_split / absent → false so a mid-session drain does not cluster. */
export function stretchEndForRun(outboxText: string, runId: string): boolean {
  return lastOutboxKind(outboxText, runId) === "stretch_end";
}

function rewriteOutbox(text: string, dropRunIds: Set<string>): string {
  return text
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        const row = JSON.parse(line) as OutboxRow;
        return !row.run_id || !dropRunIds.has(row.run_id);
      } catch {
        return true;
      }
    })
    .join("\n");
}

export async function drain(): Promise<void> {
  ensureHome();
  const cfg = readConfig();
  const site = sitePlaneUrl(cfg?.base_url);
  const wrap = wrapPlaneUrl(cfg?.base_url);
  const key = resolveApiKey();
  const headers = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const outbox = existsSync(outboxPath()) ? readFileSync(outboxPath(), "utf8") : "";
  const dropRuns = new Set<string>();
  const runsDir = `${edenHome()}/runs`;
  const files = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".sent.jsonl")) : [];
  const runIds = new Set(files.map((f) => f.replace(/\.jsonl$/, "")));
  for (const line of outbox.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as OutboxRow;
      if (row.run_id && row.kind === "stretch_end") runIds.add(row.run_id);
    } catch {
      /* skip */
    }
  }
  for (const runId of runIds) {
    const path = eventsPath(runId);
    const lines = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
    const events = lines.flatMap((l) => {
      try {
        const e = JSON.parse(l) as Record<string, unknown>;
        return ingestible(e) ? [e] : [];
      } catch {
        return [];
      }
    }).map((e, i) => ({
        event_id: e.event_id,
        seq: typeof e.seq === "number" ? e.seq : i + 1,
        name: e.name,
        args: e.args || {},
        command: e.command,
        ok: e.ok !== false,
      }));
    const stretch_end = stretchEndForRun(outbox, runId);
    if (!events.length && !stretch_end) continue;
    const res = await fetch(`${site}/v1/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent_id: "claude_code", run_id: runId, events, stretch_end }),
    });
    if (!res.ok) continue;
    if (existsSync(path)) {
      writeFileSync(path.replace(/\.jsonl$/, ".sent.jsonl"), JSON.stringify({ sent: Date.now(), n: events.length }));
      unlinkSync(path);
    }
    if (stretch_end) dropRuns.add(runId);
  }
  const wrapLive = await fetch(`${wrap}/v1/tools?state=live`, { headers: { Authorization: `Bearer ${key}` } });
  if (wrapLive.ok) {
    const json = (await wrapLive.json()) as {
      tools?: Array<{
        id?: string;
        name?: string;
        sequence?: string[];
        program?: { name?: string; sequence?: string[]; contract?: { envelope?: unknown } };
      }>;
    };
    writeFileSync(
      liveToolsPath(),
      JSON.stringify(
        (json.tools ?? []).map((t) => ({
          name: t.program?.name ?? t.name,
          sequence: t.program?.sequence ?? t.sequence ?? [],
          id: t.id,
          envelope: t.program?.contract?.envelope ?? null,
        })),
        null,
        2,
      ),
    );
  } else {
    const live = await fetch(`${site}/v1/live-tools`, { headers: { Authorization: `Bearer ${key}` } });
    if (live.ok) {
      const json = (await live.json()) as {
        tools?: unknown;
        knock?: string | { message?: string; tool_id?: string } | null;
      };
      writeFileSync(liveToolsPath(), JSON.stringify(json.tools ?? json, null, 2));
      const knockPath = `${edenHome()}/knock.json`;
      const knock = json.knock;
      if (knock) {
        const prev = existsSync(knockPath) ? JSON.parse(readFileSync(knockPath, "utf8")) : {};
        writeFileSync(
          knockPath,
          JSON.stringify({
            message: typeof knock === "string" ? knock : knock.message || knock,
            tool_id: typeof knock === "string" ? undefined : knock.tool_id,
            shown: typeof prev.shown === "number" ? prev.shown : 0,
          }),
        );
      } else if (existsSync(knockPath)) {
        unlinkSync(knockPath);
      }
    }
  }
  if (existsSync(outboxPath())) {
    withFileLock(`${outboxPath()}.lock`, () => {
      const fresh = existsSync(outboxPath()) ? readFileSync(outboxPath(), "utf8") : "";
      writeFileSync(outboxPath(), rewriteOutbox(fresh, dropRuns));
    });
  }
}

if (import.meta.main) await drain();
