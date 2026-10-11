/**
 * The PreToolUse policy guard's hook (D19, A4 §5.4, A6 §2.5, A7 §5); `memory-guard.ts` gives the answer.
 *
 * - **Handlers:** `hooks.json` registers one handler per command a class map pattern starts with (`Bash(git *)`,
 *   `Bash(gh *)`, …), and the patterns that start with a wildcard as written (`Bash(*deploy*)`). A rule that names
 *   only its command does not fire on a `$()` elsewhere in the line, where A7 §5's narrower rules each would: in a
 *   real session, `echo $(date +%Y)` started all 29 of them (P2.3's review). The plugin's `hook.ts` re-checks the
 *   call against every class before it loads this module (`memory-guard-match.ts`), so a call no class is costs a
 *   process start, and logs nothing.
 * - **Flags** (X7): `guard.context` gives the rule to Claude, `guard.ask` asks the user. An ask always carries its
 *   context (A6 §2.5: the guard sends both), unless `guard.context` is `off`. A point in `shadow` prints nothing and
 *   records what it would have said: the shadow ledger and `would_ask` in the wide event. `EDEN_POLICY_GUARD=off`
 *   turns the whole guard off (D19), not the ask alone.
 * - **One answer per call:** handlers of one call (`git push && gh pr merge`) compute the same answer; the first to
 *   record the call in the window's `guard.log` answers, the rest stay silent (`memory-guard-log.ts`).
 * - **Ledger** (A4 §4): what the guard tells is recorded like a packet, outside the refractory rule and the budget
 *   (a violation re-delivers).
 * - **Consent:** read-only writes nothing, so it cannot keep one answer per call: the guard says nothing.
 * - **Fail open:** an error prints nothing; the circuit breaker checks `guard.context`'s budget.
 */
import { errorTag } from "../../../src/memory-events";
import { resolveFlags, type FlagState } from "../../../src/memory-flags";
import { memoryConsent } from "../../../src/memory-consent";
import { memoryNow } from "../../../src/memory-clock";
import { guardAnswer, type GuardAnswer } from "../../../src/memory-guard";
import { guardedCall, type GuardCall } from "../../../src/memory-guard-match";
import { claimCall } from "../../../src/memory-guard-log";
import { deliveredKeys, humanTurns, ledgerKey, packetTokens, recordPacket } from "../../../src/memory-ledger";
import { readableStore, repoStoreDir, swapping } from "../../../src/memory-repo";
import { ledgerFor, transcriptOffset, windowDir } from "../../../src/memory-window";
import {
  asRec,
  eventRepo,
  logInvocation,
  memoryRoot,
  resolveSession,
  str,
  transcriptOf,
  type Trace,
} from "./memory-hook-io";

/** Records what the guard told in the window's ledger of its mode (A4 §4). */
function recordTold(
  r: Record<string, unknown>,
  at: { win: string; ht: number },
  answer: GuardAnswer,
  repo: string,
  told: boolean,
): void {
  const file = ledgerFor(told ? "on" : "shadow");
  if (!file) return;
  const moment = { off: transcriptOffset(transcriptOf(r)), att: str(r.prompt_id) ?? "", ht: at.ht };
  const keys = answer.rows.flatMap((row) => deliveredKeys(row, repo));
  recordPacket(at.win, { keys, tokens: packetTokens(answer.context) }, moment, file);
}

/** What the guard prints for a call, and records (see the header). */
function guard(r: Record<string, unknown>, flags: FlagState, trace: Trace): Record<string, unknown> | null {
  const contextMode = flags["guard.context"].mode;
  const askMode = flags["guard.ask"].mode;
  Object.assign(trace, { point: "guard.context", mode: contextMode });
  if (contextMode === "off" && askMode === "off") return null;
  const call: GuardCall = { tool: str(r.tool_name) ?? "", input: asRec(r.tool_input) };
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
  const ht = humanTurns(win);
  const record = { k: "call" as const, t: memoryNow(), id, cls: answer.cls, rules: answer.rules, ht };
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
    recordTold(r, { win, ht }, answer, repo.key, told);
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

/** Whether the user's environment turned the guard off: `EDEN_POLICY_GUARD=off` is its kill switch (D19). */
function switchedOff(flags: FlagState): boolean {
  return flags["guard.ask"].source === "env" && flags["guard.ask"].mode === "off";
}

/**
 * The guard's response to a PreToolUse payload (see the header). A call no class is, or a guard switched off,
 * answers and logs nothing. Fails open: null.
 */
export function guardHookResponse(raw: Record<string, unknown>): Record<string, unknown> | null {
  const started = performance.now();
  let r: Record<string, unknown>;
  let flags: FlagState;
  try {
    r = asRec(raw);
    if (memoryConsent() !== "on" || !guardedCall(r) || swapping(memoryRoot())) return null;
    flags = resolveFlags(str(r.cwd));
    if (switchedOff(flags)) return null;
  } catch {
    return null;
  }
  const trace: Trace = { ev: "PreToolUse" };
  let out: Record<string, unknown> | null = null;
  try {
    out = guard(r, flags, trace);
  } catch (err) {
    trace.err = errorTag(err);
    out = null;
  }
  logInvocation(trace, flags, performance.now() - started);
  return out;
}

/** The guard for a payload `hook.ts` has read and found guarded; prints its answer, if any. */
export function runGuardHook(body: Record<string, unknown>): void {
  try {
    const out = guardHookResponse(body);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {}
}
