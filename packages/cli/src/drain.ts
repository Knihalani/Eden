import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { eventsPath, liveToolsPath, outboxPath, readConfig, ensureHome, edenHome } from "./home";

function ingestible(row: Record<string, unknown>): boolean {
  const hook = String(row.hook || "");
  if (hook === "PreToolUse") return false;
  if (hook === "SessionStart" || hook === "Stop" || hook === "UserPromptSubmit") return false;
  return Boolean(row.name);
}

export async function drain(): Promise<void> {
  ensureHome();
  const cfg = readConfig();
  const base = cfg?.base_url || process.env.EDEN_BASE_URL || "http://127.0.0.1:8787";
  const key = cfg?.api_key || process.env.EDEN_API_KEY || "eden_dev";
  const headers = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const runsDir = `${edenHome()}/runs`;
  const files = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".sent.jsonl")) : [];
  for (const f of files) {
    const runId = f.replace(/\.jsonl$/, "");
    const path = eventsPath(runId);
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    const events = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter(ingestible)
      .map((e, i) => ({
        event_id: e.event_id,
        seq: typeof e.seq === "number" ? e.seq : i + 1,
        name: e.name,
        args: e.args || {},
        command: e.command,
        ok: e.ok !== false,
      }));
    if (events.length) {
      const res = await fetch(`${base}/v1/ingest`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agent_id: "claude_code", run_id: runId, events, stretch_end: true }),
      });
      if (!res.ok) continue;
    }
    writeFileSync(path.replace(/\.jsonl$/, ".sent.jsonl"), JSON.stringify({ sent: Date.now(), n: events.length }));
    unlinkSync(path);
  }
  const live = await fetch(`${base}/v1/live-tools`, { headers: { Authorization: `Bearer ${key}` } });
  if (live.ok) {
    const json = await live.json();
    writeFileSync(liveToolsPath(), JSON.stringify(json.tools ?? json, null, 2));
    const knockPath = `${edenHome()}/knock.json`;
    if (json.knock) {
      const prev = existsSync(knockPath) ? JSON.parse(readFileSync(knockPath, "utf8")) : {};
      writeFileSync(
        knockPath,
        JSON.stringify({
          message: json.knock.message || json.knock,
          shown: typeof prev.shown === "number" ? prev.shown : 0,
        }),
      );
    } else if (existsSync(knockPath)) {
      unlinkSync(knockPath);
    }
  }
  if (existsSync(outboxPath())) writeFileSync(outboxPath(), "");
}

if (import.meta.main) await drain();
