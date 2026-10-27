import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { applyFlushTruncate, dropConsumedLines } from "./hook";
import {
  eventsPath,
  liveToolsPath,
  outboxPath,
  readConfig,
  ensureHome,
  edenHome,
  readJson,
  resolveApiKey,
  withFileLock,
  wrapPlaneUrl,
  sitePlaneUrl,
  writeFileAtomic,
} from "./home";
import { protocolHeaders, whenToUseOf } from "@eden/ir";
import { refreshOptedInSurfaces, type ManifestTool } from "./manifest";

function ingestible(row: Record<string, unknown>): boolean {
  const hook = String(row.hook || "");
  if (hook === "PreToolUse") return false;
  if (
    hook === "SessionStart" ||
    hook === "Stop" ||
    hook === "SessionEnd" ||
    hook === "UserPromptSubmit" ||
    hook === "PreCompact"
  )
    return false;
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
    } catch {}
  }
  return last;
}

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
    .map((line) => `${line}\n`)
    .join("");
}

export type DrainOpts = { workspace?: string };

export async function drain(opts: DrainOpts = {}): Promise<void> {
  ensureHome();
  const cfg = readConfig();
  const site = sitePlaneUrl(cfg?.base_url);
  const wrap = wrapPlaneUrl(cfg?.base_url);
  const key = resolveApiKey();
  const headers = { Authorization: `Bearer ${key}`, "content-type": "application/json", ...protocolHeaders() };
  const outbox = existsSync(outboxPath()) ? readFileSync(outboxPath(), "utf8") : "";
  const dropRuns = new Set<string>();
  const runsDir = `${edenHome()}/runs`;
  const files = existsSync(runsDir)
    ? readdirSync(runsDir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".sent.jsonl"))
    : [];
  const runIds = new Set(files.map((f) => f.replace(/\.jsonl$/, "")));
  for (const line of outbox.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as OutboxRow;
      if (row.run_id && row.kind === "stretch_end") runIds.add(row.run_id);
    } catch {}
  }
  for (const runId of runIds) {
    const path = eventsPath(runId);
    const lines = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
    const events = lines
      .flatMap((l) => {
        try {
          const e = JSON.parse(l) as Record<string, unknown>;
          return ingestible(e) ? [e] : [];
        } catch {
          return [];
        }
      })
      .map((e, i) => ({
        event_id: e.event_id ?? e.id,
        seq: typeof e.seq === "number" ? e.seq : i + 1,
        name: e.name,
        args: e.args || {},
        command: e.command,
        ok: e.ok !== false,
      }));
    const stretch_end = stretchEndForRun(outbox, runId);
    if (!events.length && !stretch_end) continue;
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
    if (stretch_end) dropRuns.add(runId);
    const sentIds = events.map((e) => String(e.event_id ?? "")).filter(Boolean);
    try {
      withFileLock(`${path}.lock`, () => {
        if (sentIds.length) applyFlushTruncate(path, sentIds);
        dropConsumedLines(path, lines);
      });
    } catch {}
  }
  try {
    await refreshLiveTools(site, wrap, key, opts.workspace);
  } catch {}
  if (existsSync(outboxPath())) {
    withFileLock(`${outboxPath()}.lock`, () => {
      const fresh = existsSync(outboxPath()) ? readFileSync(outboxPath(), "utf8") : "";
      writeFileAtomic(outboxPath(), rewriteOutbox(fresh, dropRuns));
    });
  }
}

type PlaneTool = {
  id?: string;
  name?: string;
  sequence?: unknown;
  read_only?: unknown;
  transparent_writes?: unknown;
  rollout?: unknown;
  when_to_use?: unknown;
  description?: unknown;
  envelope?: unknown;
  program?: {
    name?: string;
    sequence?: unknown;
    description?: unknown;
    when_to_use?: unknown;
    read_only?: unknown;
    transparent_writes?: unknown;
    rollout?: unknown;
    steps?: unknown;
    contract?: { envelope?: unknown };
  };
};

function nonEmptyString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function whenFromProgram(program: NonNullable<PlaneTool["program"]>): string | undefined {
  const description = typeof program.description === "string" ? program.description : "";
  const steps = Array.isArray(program.steps)
    ? program.steps.map((raw) => {
        const s = raw && typeof raw === "object" ? (raw as { kind?: unknown; when_to_use?: unknown }) : {};
        return {
          kind: typeof s.kind === "string" ? s.kind : "",
          when_to_use: typeof s.when_to_use === "string" ? s.when_to_use : undefined,
        };
      })
    : undefined;
  return nonEmptyString(
    whenToUseOf({
      description,
      when_to_use: typeof program.when_to_use === "string" ? program.when_to_use : undefined,
      steps,
    }),
  );
}

export function projectLiveTools(tools: unknown): ManifestTool[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((raw) => {
    const t = (raw && typeof raw === "object" ? raw : {}) as PlaneTool;
    const program = t.program;
    const name = nonEmptyString(program?.name) ?? nonEmptyString(t.name);
    const sequence = stringList(program?.sequence ?? t.sequence);
    const when =
      nonEmptyString(t.when_to_use) ??
      (program ? whenFromProgram(program) : undefined) ??
      nonEmptyString(t.description);
    const readOnly =
      typeof t.read_only === "boolean"
        ? t.read_only
        : typeof program?.read_only === "boolean"
          ? program.read_only
          : undefined;
    const envelope = program?.contract?.envelope ?? t.envelope ?? null;
    const writes = t.transparent_writes === true || program?.transparent_writes === true;
    const rawRollout = t.rollout ?? program?.rollout;
    const rollout = rawRollout === "canary" || rawRollout === "live" ? rawRollout : undefined;
    return {
      ...(name ? { name } : {}),
      sequence,
      ...(typeof t.id === "string" ? { id: t.id } : {}),
      envelope,
      ...(typeof readOnly === "boolean" ? { read_only: readOnly } : {}),
      ...(when ? { when_to_use: when } : {}),
      ...(writes ? { transparent_writes: true } : {}),
      ...(rollout ? { rollout } : {}),
    };
  });
}

function persistLiveTools(tools: ManifestTool[], workspace?: string): void {
  writeFileAtomic(liveToolsPath(), JSON.stringify(tools, null, 2) + "\n");
  try {
    refreshOptedInSurfaces(tools, { workspace });
  } catch {}
}

async function refreshLiveTools(site: string, wrap: string, key: string, workspace?: string): Promise<void> {
  const wrapLive = await fetch(`${wrap}/v1/tools?state=live`, { headers: { Authorization: `Bearer ${key}` } });
  if (wrapLive.ok) {
    const json = (await wrapLive.json()) as { tools?: unknown };
    persistLiveTools(projectLiveTools(json.tools), workspace);
  } else {
    const live = await fetch(`${site}/v1/live-tools`, { headers: { Authorization: `Bearer ${key}` } });
    if (live.ok) {
      const json = (await live.json()) as {
        tools?: unknown;
        knock?: string | { message?: string; tool_id?: string } | null;
      };
      persistLiveTools(projectLiveTools(json.tools), workspace);
      const knockPath = `${edenHome()}/knock.json`;
      const knock = json.knock;
      if (knock) {
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
