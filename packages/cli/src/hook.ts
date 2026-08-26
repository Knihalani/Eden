import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { edenHome, ensureHome, appendJsonl, eventsPath, readConfig, readJson, withFileLock, withFileLockAsync, outboxPath, wrapPlaneUrl, writeFileAtomic } from "./home";
import { redact, isStretchEnd, inDistribution, protocolHeaders } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";
import { eligibleForTransparent, executeTransparent, postToolUseReplacement, type LiveTool } from "./transparent";

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
    body = {}
  }
  // The last line of defence for "a broken Eden never blocks the agent". Any
  // throw in here — a stale lock, an unreadable home directory, a corrupt run
  // log — used to exit non-zero with empty stdout. `{}` is the answer that
  // lets the tool call proceed.
  //
  // The same defence against *hanging*: Claude Code waits on this process, so
  // respondToHook is raced against a hard timeout. A wedged lock or a slow
  // disk costs Eden its recording for one event; it never costs the agent its
  // tool call.
  const HOOK_TIMEOUT_MS = 2_500;
  let out: Record<string, unknown> = { ok: true };
  try {
    out = await Promise.race([
      respondToHook(body),
      new Promise<Record<string, unknown>>((resolve) =>
        setTimeout(() => resolve({ ok: true, eden_timeout: true }), HOOK_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    process.stderr.write(`eden hook: ${(err as Error)?.message ?? String(err)}\n`);
    out = {};
  }
  process.stdout.write(JSON.stringify(out));
}

/**
 * The lock a hook run takes around each session-file mutation.
 *
 * One-shot `eden hook` processes keep the sync {@link withFileLock}: the
 * process exists for one event, has nothing else to serve, and spinning on
 * sleepSync costs it nothing. hookd passes {@link withFileLockAsync} instead —
 * sleepSync parks its whole event loop, so one contended lock stalled every
 * other session's request behind it.
 */
export type HookLocker = <T>(lockPath: string, fn: () => T) => T | Promise<T>;

function readConfigSafely(): { steer_hooks?: boolean } | null {
  try {
    return readConfig();
  } catch {
    return null;
  }
}

function readJsonl(path: string): Array<Record<string, unknown>> {  if (!existsSync(path)) return [];
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

/** Tools-only hook stretch. Real `usage` is attached at ingest from the chat proxy. */
export function hookTraceBody(events: Array<Record<string, unknown>>): Record<string, unknown> {
  const first = events[0]!;
  const t0 = Number(first.ts ?? Date.now());
  const t1 = Number(events.at(-1)?.ts ?? t0);
  return {
    events,
    input: first.args ?? {},
    output: lastOkResult(events),
    llmCalls: 0,
    duration_ms: Math.max(0, t1 - t0),
    cost_cents: 0,
    complete: true,
  };
}

function lastOkResult(events: Array<Record<string, unknown>>): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.ok !== false && ev.result !== undefined) return ev.result;
  }
  return undefined;
}

function flushSession(session: string, events: Array<Record<string, unknown>>): void {
  const cfg = readConfig();
  if (!cfg || events.length < 2) return;
  const path = eventsPath(session);
  const flushedIds = events.map((e) => String(e.id ?? ""));
  void fetch(`${wrapPlaneUrl(cfg.base_url)}/v1/traces`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.api_key}`, "content-type": "application/json", ...protocolHeaders() },
    body: JSON.stringify({ id: crypto.randomUUID(), ...hookTraceBody(events) }),
  })
    .then((r) => {
      if (r.ok) withFileLock(`${path}.lock`, () => applyFlushTruncate(path, flushedIds));
    })
    .catch(() => undefined);
}

/**
 * Drop the events that were successfully uploaded, keeping everything else.
 *
 * Two failure modes this has to avoid, both of which lose events:
 *  - An empty id set used to fall through to `rest = []`, i.e. "nothing was
 *    confirmed sent, so delete the entire log". Callers happen to guard
 *    against it today, but the safe reading of "no ids to drop" is to drop
 *    nothing.
 *  - Rewriting in place truncates first and writes after. A crash, a full
 *    disk, or a power loss in between leaves the log empty or ending in half a
 *    line, which `readJsonl` then cannot parse. Writing a sibling temp file
 *    and renaming makes the replacement atomic: readers see either the old
 *    file or the new one, never a partial one.
 */
/**
 * Drop exactly the lines a caller has finished with, keeping anything that
 * arrived since it read them.
 *
 * Matching on the raw line text rather than unlinking the file is what makes
 * this safe against a hook appending during an in-flight upload: a line the
 * caller never saw cannot be in `consumed`.
 */
export function dropConsumedLines(path: string, consumed: string[]): void {
  if (!consumed.length || !existsSync(path)) return;
  const drop = new Set(consumed);
  const current = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const rest = current.filter((l) => !drop.has(l));
  if (rest.length === current.length) return;
  writeFileAtomic(path, rest.length ? rest.join("\n") + "\n" : "");
  // The log just shrank behind the cursor's back; re-anchor it so the hot path
  // does not act on a count that no longer describes the file.
  setCursorLines(path, rest.length);
}

export function applyFlushTruncate(path: string, flushedIds: string[]): void {
  const drop = new Set(flushedIds.filter(Boolean));
  if (!drop.size) return;
  const current = readJsonl(path);
  const rest = current.filter((e) => !drop.has(String(e.id ?? "")));
  if (rest.length === current.length) return;
  writeFileAtomic(path, rest.length ? rest.map((e) => JSON.stringify(e)).join("\n") + "\n" : "");
  setCursorLines(path, rest.length);
}

/**
 * Flushed-cursor sidecar: `<session>.jsonl.cursor.json`.
 *
 * PostToolUse fires on every tool call and used to re-read and JSON-parse the
 * *entire* session log synchronously just to learn its line count for the
 * stretch-end check. The sidecar records how many lines have been appended,
 * under the same file lock as the append itself, so the hot path touches only
 * this tiny file; the full log is read where it is actually needed — at a
 * stretch end, or once after the count has been invalidated (a lost or corrupt
 * sidecar, or another writer having truncated the log).
 *
 * A cursor that has drifted high only makes the stretch-end check fire early,
 * and the authoritative `events.length >= 2` guard in flushSession still runs
 * on the real snapshot — so drift costs a redundant read, never a lost or
 * duplicated event. "Every event flushed exactly once" stays owned by the id
 * matching in applyFlushTruncate.
 */
function cursorPathFor(path: string): string {
  return `${path}.cursor.json`;
}

function readCursorLines(path: string): number | null {
  try {
    const c = JSON.parse(readFileSync(cursorPathFor(path), "utf8")) as { lines?: unknown };
    if (typeof c?.lines === "number" && Number.isInteger(c.lines) && c.lines >= 0) return c.lines;
  } catch {
    /* absent, corrupt, or half-written: fall through to a rebuild */
  }
  return null;
}

function setCursorLines(path: string, lines: number): void {
  writeFileAtomic(cursorPathFor(path), JSON.stringify({ lines }));
}

function countSessionLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

/**
 * One appended event later. Must run under `${path}.lock`, alongside the
 * append it counts, so the sidecar can never describe a line that was not
 * written or miss one that was.
 *
 * A missing or invalid cursor is rebuilt from the real log once (the
 * invalidation path) rather than silently restarting at zero, which would
 * suppress stretch-end flushing until two more events happened by. The rebuild
 * count is taken *before* the append so the fresh line itself is not counted
 * twice.
 */
export function recordAppendedEvent(path: string, append: () => void): number {
  const prev = readCursorLines(path);
  const lines = (prev ?? countSessionLines(path)) + 1;
  append();
  setCursorLines(path, lines);
  return lines;
}

export async function respondToHook(
  body: HookIn,
  locker: HookLocker = withFileLock,
): Promise<Record<string, unknown>> {
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
    const path = eventsPath(session);
    // Append and count under one lock acquisition: the hot path never opens
    // the session log itself, only the tiny cursor sidecar.
    let lineCount = 0;
    await locker(`${path}.lock`, () => {
      lineCount = recordAppendedEvent(path, () => appendJsonl(path, event));
    });
    // Full read only at a stretch end; flushSession's own `events.length >= 2`
    // guard on the real snapshot stays authoritative.
    if (lineCount >= 2 && isStretchEnd(name)) {
      const events = readJsonl(path);
      if (events.length >= 2) flushSession(session, events);
    }
    // Transparent execution: this call matched a live read-only program's
    // first step — serve the rest of the routine by replacing this call's
    // output. Recording above already happened; every failure below falls
    // open to `{ ok: true }` so the agent's own output stands.
    try {
      const liveRaw = readJson<unknown>(join(edenHome(), "live-tools.json"), []);
      const live = (Array.isArray(liveRaw) ? liveRaw : []) as LiveTool[];
      const entry = live.find(
        (t) => (t.sequence ?? [])[0] === name && eligibleForTransparent(t, body.tool_input ?? {}),
      );
      if (entry) {
        const receiptText = await executeTransparent(entry, body.tool_input ?? {});
        if (receiptText !== null) {
          // `name` (the real tool, e.g. Bash) selects the native result shape;
          // the program name appears in the appended sentinel.
          return postToolUseReplacement(name, body.tool_response ?? body.tool_output ?? "", receiptText, entry.name);
        }
      }
    } catch {
      /* fall open */
    }
  }
  if (body.hook_event_name === "Stop" || body.hook_event_name === "SessionEnd") {
    await locker(`${outboxPath()}.lock`, () =>
      appendJsonl(outboxPath(), { run_id: session, kind: "stretch_end", ts: Date.now() }),
    );
    const path = eventsPath(session);
    const events = readJsonl(path);
    if (events.length >= 2) flushSession(session, events);
  }
  // readJson only guards against a parse error, not against the file holding
  // something other than an array. drain writes `json.tools ?? json`, so a site
  // response without a `tools` key — a proxy error page, a version skew — put
  // an *object* here and `live.some(...)` then threw on every single PreToolUse.
  const liveRaw = readJson<unknown>(join(edenHome(), "live-tools.json"), []);
  const live = (
    Array.isArray(liveRaw) ? liveRaw : []
  ) as Array<{ name: string; sequence?: string[]; envelope?: { inputs?: Record<string, unknown[]> } }>;
  // Config is advisory here: a corrupt or half-written config.json must not
  // stop the hook from answering (an answer of "allow" is always available).
  const cfg = readConfigSafely();
  if (body.hook_event_name === "PreToolUse" && name) {
    if (live.some((t) => t.name === name)) return { ok: true };
    // Steering a raw call to the MCP tool is opt-in (steer_hooks in config, or
    // EDEN_STEER_HOOKS=1). Default is observe: Eden records the pattern but
    // never denies the agent's own call — if the MCP server is down, mid-restart,
    // or the compiled tool deopts, a deny here would leave the agent stranded
    // with no way to do the work at all.
    const steerHooks =
      process.env.EDEN_STEER_HOOKS === "1" || cfg?.steer_hooks === true;
    if (!steerHooks) return { ok: true };
    const hits = live
      .filter((t) => (t.sequence ?? [])[0] === name)
      .sort((a, b) => (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0));
    const hit = hits[0];
    // Never deny in favour of a tool we cannot name. drain writes
    // `name: t.program?.name ?? t.name`, either of which may be undefined, and
    // the result was a hard deny on every Bash call telling the agent to "use
    // the Eden compiled tool null" — Eden bricking the user's agent, which is
    // the one thing it must never do.
    if (hit && typeof hit.name === "string" && hit.name.length > 0) {
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
