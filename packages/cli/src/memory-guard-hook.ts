/**
 * The PreToolUse policy guard's hook (D19, A4 §5.4, A6 §2.5, A7 §5). `hooks.json` registers one handler per
 * `(class, pattern)` of the class command map, each running `hook.ts guard <class>`; `memory-guard.ts` gives the
 * answer. Around it:
 *
 * - **Flags** (X7): `guard.context` gives the rule to Claude, `guard.ask` asks the user. An ask always carries its
 *   context (A6 §2.5: the guard sends both), unless `guard.context` is `off`. A point in `shadow` prints nothing and
 *   records what it would have said: the shadow ledger and `would_ask` in the wide event.
 * - **Re-check:** a handler answers only when its own class matches the call (`if` is best-effort).
 * - **One answer per call:** parallel handlers of one call compute the same answer; the first to record the call in
 *   the window's `guard.log` answers, the rest stay silent (`memory-guard-log.ts`).
 * - **Ledger** (A4 §4): what the guard tells is recorded like a packet, outside the refractory rule and the budget
 *   (a violation re-delivers).
 * - **Consent:** read-only writes nothing, so it cannot keep one answer per call: the guard says nothing.
 * - **Fail open:** an error prints nothing; the circuit breaker checks `guard.context`'s budget.
 */
import { errorTag } from "../../../src/memory-events";
import { resolveFlags, type FlagState } from "../../../src/memory-flags";
import { memoryConsent } from "../../../src/memory-consent";
import { memoryNow } from "../../../src/memory-clock";
import { callClasses, guardAnswer, type GuardAnswer, type GuardCall } from "../../../src/memory-guard";
import { claimCall } from "../../../src/memory-guard-log";
import { deliveredKeys, humanTurns, ledgerKey, packetTokens, recordPacket } from "../../../src/memory-ledger";
import { readableStore, repoStoreDir, swapping } from "../../../src/memory-repo";
import { ledgerFor, transcriptOffset, windowDir } from "../../../src/memory-window";
import {
  asRec,
  eventRepo,
  logInvocation,
  memoryRoot,
  readHookPayload,
  resolveSession,
  str,
  transcriptOf,
  type Trace,
} from "./memory-hook";

/** Records what the guard told in the window's ledger of its mode (A4 §4). */
function recordTold(r: Record<string, unknown>, win: string, answer: GuardAnswer, repo: string, told: boolean): void {
  const file = ledgerFor(told ? "on" : "shadow");
  if (!file) return;
  const moment = { off: transcriptOffset(transcriptOf(r)), att: str(r.prompt_id) ?? "", ht: humanTurns(win) };
  const keys = answer.rows.flatMap((row) => deliveredKeys(row, repo));
  recordPacket(win, { keys, tokens: packetTokens(answer.context) }, moment, file);
}

/** What the guard prints for a call, and records (see the header). */
function guard(
  r: Record<string, unknown>,
  cls: string,
  flags: FlagState,
  trace: Trace,
): Record<string, unknown> | null {
  const contextMode = flags["guard.context"].mode;
  const askMode = flags["guard.ask"].mode;
  Object.assign(trace, { point: "guard.context", mode: contextMode, guard_class: cls });
  if (contextMode === "off" && askMode === "off") return null;
  const call: GuardCall = { tool: str(r.tool_name) ?? "", input: asRec(r.tool_input) };
  if (!callClasses(call).includes(cls as never)) return null;
  const root = memoryRoot();
  const resolved = resolveSession(r, "PreToolUse");
  const win = windowDir(root, resolved.session ?? "");
  const repo = eventRepo(str(r.cwd) ?? process.cwd(), windowDir(root, resolved.parent ?? ""), false);
  const store = repo && repoStoreDir(root, repo.key);
  if (!win || !repo || !store || !readableStore(store)) return null;
  Object.assign(trace, { repo: repo.key, win: win.split("/").at(-1) });
  const permissionMode = str(r.permission_mode) ?? "default";
  const answer = guardAnswer(store, call, permissionMode);
  if (!answer) return null;
  const id = str(r.tool_use_id) ?? "";
  const asked = askMode === "on" && answer.ask;
  const told = contextMode === "on" || (asked && contextMode !== "off");
  const record = { k: "call" as const, t: memoryNow(), id, cls: answer.cls, rules: answer.rules };
  if (!claimCall(win, { ...record, due: answer.due, ask: asked, mode: permissionMode })) {
    trace.guard_dup = true;
    return null;
  }
  Object.assign(trace, {
    tool_use_id: id,
    guard_class: answer.cls,
    cids: answer.rows.map((row) => ledgerKey(row, repo.key).cid),
    ids: answer.rows.map((row) => row.id),
    ...(answer.due ? { would_ask: true } : {}),
    ...(asked ? { asked: true } : {}),
    ...(answer.bypassed ? { guard_bypassed: true } : {}),
  });
  try {
    recordTold(r, win, answer, repo.key, told);
  } catch {}
  if (!told && !asked) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...(told ? { additionalContext: answer.context } : {}),
      ...(asked ? { permissionDecision: "ask", permissionDecisionReason: answer.reason } : {}),
    },
  };
}

/** The guard's response to a PreToolUse payload for its class (see the header). Fails open: null. */
export function guardHookResponse(
  raw: Record<string, unknown>,
  cls: string | undefined,
): Record<string, unknown> | null {
  const started = performance.now();
  let r: Record<string, unknown>;
  try {
    r = asRec(raw);
    if (memoryConsent() !== "on" || !cls || r.hook_event_name !== "PreToolUse" || swapping(memoryRoot())) return null;
  } catch {
    return null;
  }
  const trace: Trace = { ev: "PreToolUse" };
  let flags: FlagState | undefined;
  let out: Record<string, unknown> | null = null;
  try {
    flags = resolveFlags(str(r.cwd));
    out = guard(r, cls, flags, trace);
  } catch (err) {
    trace.err = errorTag(err);
    out = null;
  }
  logInvocation(trace, flags, performance.now() - started);
  return out;
}

export async function runGuardHookStdin(cls?: string): Promise<void> {
  const body = await readHookPayload();
  try {
    const out = guardHookResponse(body, cls);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {}
}
