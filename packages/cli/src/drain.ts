import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { applyFlushTruncate, dropConsumedLines } from "./hook";
import { eventsPath, liveToolsPath, outboxPath, readConfig, ensureHome, edenHome, readJson, resolveApiKey, withFileLock, wrapPlaneUrl, sitePlaneUrl, writeFileAtomic } from "./home";
import { protocolHeaders } from "@eden/ir";

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

export function rewriteOutbox(text: string, dropRunIds: Set<string>): string {
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
    // Trailing newline, or the next appendJsonl() concatenates onto the last
    // record and destroys two rows at once: the one it lands on and its own.
    // Because stretch_end markers live in this file, a swallowed marker means
    // the run never clusters — a silent, permanent loss of the core signal.
    .map((line) => `${line}\n`)
    .join("");
}

export async function drain(): Promise<void> {
  ensureHome();
  const cfg = readConfig();
  const site = sitePlaneUrl(cfg?.base_url);
  const wrap = wrapPlaneUrl(cfg?.base_url);
  const key = resolveApiKey();
  const headers = { Authorization: `Bearer ${key}`, "content-type": "application/json", ...protocolHeaders() };
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
        // The hook writes `id`; only `event_id` was read here, so the field
        // arrived undefined on every event. Ingest keys `tool_event` on it for
        // `INSERT OR IGNORE` dedup, and SQLite allows unlimited NULLs in a TEXT
        // primary key — so every retry duplicated every event, and on Postgres
        // (where a primary key implies NOT NULL) ingest would reject the batch
        // outright and the run log would never drain at all.
        event_id: e.event_id ?? e.id,
        seq: typeof e.seq === "number" ? e.seq : i + 1,
        name: e.name,
        args: e.args || {},
        command: e.command,
        ok: e.ok !== false,
      }));
    const stretch_end = stretchEndForRun(outbox, runId);
    if (!events.length && !stretch_end) continue;
    // fetch *rejects* on ECONNREFUSED rather than resolving, and there was no
    // try/catch anywhere in drain(). One unreachable site aborted the whole
    // loop before the outbox rewrite below, so with the plane down drain was a
    // permanent no-op rather than a retry.
    let res: Response;
    try {
      res = await fetch(`${site}/v1/ingest`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agent_id: "claude_code", run_id: runId, events, stretch_end }),
      });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    // Recorded before any of the early exits below. This used to sit after the
    // `continue` on the healthy path, so dropRuns stayed empty, rewriteOutbox
    // removed nothing, and the row was immortal — every later drain re-POSTed
    // stretch_end for a run that was still live, and the outbox grew forever.
    if (stretch_end) dropRuns.add(runId);
    // Remove exactly the events that were sent, under the lock, rather than
    // unlinking the file. The read, the POST and the delete all happened
    // outside the lock, so any PostToolUse hook that fired during the request
    // window had its event written into a file that was then destroyed.
    const sentIds = events.map((e) => String(e.event_id ?? "")).filter(Boolean);
    try {
      // Remove exactly the lines this drain consumed, under the lock. The old
      // fallback for "nothing had an id" unlinked the whole file, and it sat
      // *outside* the lock — so a PostToolUse hook that correctly took the
      // lock and appended during the in-flight POST had its event destroyed.
      // Matching on the raw lines we read keeps anything appended since.
      withFileLock(`${path}.lock`, () => {
        if (sentIds.length) applyFlushTruncate(path, sentIds);
        dropConsumedLines(path, lines);
      });
    } catch {
      // Contended or unwritable: leave the file alone. Re-sending is
      // harmless now that event_id makes ingest idempotent; losing events
      // is not.
    }
  }
  // Refreshing the live-tool list is best effort. It used to sit unguarded
  // between the ingest loop and the outbox rewrite, so an unreachable wrap or
  // site plane threw straight past the rewrite and drain never drained.
  try {
    await refreshLiveTools(site, wrap, key);
  } catch {
    /* keep the tool list we already have */
  }
  if (existsSync(outboxPath())) {
    withFileLock(`${outboxPath()}.lock`, () => {
      const fresh = existsSync(outboxPath()) ? readFileSync(outboxPath(), "utf8") : "";
      // Atomic, like applyFlushTruncate: this file holds the stretch_end
      // markers, and an in-place rewrite that dies halfway loses them.
      writeFileAtomic(outboxPath(), rewriteOutbox(fresh, dropRuns));
    });
  }
}


async function refreshLiveTools(site: string, wrap: string, key: string): Promise<void> {
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
      // `json.tools ?? json` wrote an *object* whenever the response had no
      // `tools` key — a proxy error page, a version skew — and the hook then
      // threw on every PreToolUse trying to iterate it. The reader guards this
      // too now; writing something unusable in the first place is the bug.
      writeFileSync(liveToolsPath(), JSON.stringify(Array.isArray(json.tools) ? json.tools : [], null, 2));
      const knockPath = `${edenHome()}/knock.json`;
      const knock = json.knock;
      if (knock) {
        // A corrupt knock.json used to throw out of drain() before the outbox
        // rewrite below, so the outbox never drained either.
        const prev = readJson<{ shown?: number }>(knockPath, {});
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
}

if (import.meta.main) await drain();
