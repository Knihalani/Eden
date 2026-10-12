/**
 * `PreToolUse(Agent)`'s handler (A4 §5.3, D23): records the launch's task paths and classes in the session's
 * `spawn.log` (`memory-spawn.ts`), which the subagent's SubagentStart reads, since that payload carries no task prompt
 * (R0 F27). It prints nothing, opens no store and never decides the call: kept apart from `memory-hook.ts`, as the
 * guard is, so the handler loads none of the store (A4: context-free, < 20 ms).
 *
 * - **Flag** (X7): with `deliver.subagent` off nothing reads the record, so none is made. In shadow and on alike the
 *   launch is recorded: it is no delivery.
 * - **Consent:** read-only writes nothing.
 * - **Fail open:** an error records nothing and is logged in the wide event.
 */
import { errorTag } from "../../../src/memory-events";
import { resolveFlags, type FlagState } from "../../../src/memory-flags";
import { memoryConsent } from "../../../src/memory-consent";
import { memoryNow } from "../../../src/memory-clock";
import { gitPlace, swapping } from "../../../src/memory-repo";
import { recordSpawn, spawnOf } from "../../../src/memory-spawn";
import { windowDir } from "../../../src/memory-window";
import { asRec, logInvocation, memoryRoot, resolveSession, str, type Trace } from "./memory-hook-io";
import { basename } from "node:path";

/** Records an Agent call's launch (see the header). */
export function spawnHookResponse(raw: Record<string, unknown>): void {
  const started = performance.now();
  let r: Record<string, unknown>;
  let flags: FlagState;
  try {
    r = asRec(raw);
    if (r.hook_event_name !== "PreToolUse" || r.tool_name !== "Agent") return;
    if (memoryConsent() !== "on" || swapping(memoryRoot())) return;
    flags = resolveFlags(str(r.cwd));
    if (flags["deliver.subagent"].mode === "off") return;
  } catch {
    return;
  }
  const trace: Trace = { ev: "PreToolUse" };
  try {
    const win = windowDir(memoryRoot(), resolveSession(r, "PreToolUse").parent ?? "");
    const cwd = str(r.cwd) ?? process.cwd();
    const spawn = win ? spawnOf(r, gitPlace(cwd)?.top ?? cwd, memoryNow()) : undefined;
    if (win && spawn) {
      recordSpawn(win, spawn);
      Object.assign(trace, {
        win: basename(win),
        tool_use_id: spawn.id,
        spawn: { type: spawn.type, paths: spawn.paths.length, classes: spawn.classes },
      });
    }
  } catch (err) {
    trace.err = errorTag(err);
  }
  logInvocation(trace, flags, performance.now() - started);
}

/** The handler for a payload `hook.ts` has read: it prints nothing. */
export function runSpawnHook(body: Record<string, unknown>): void {
  try {
    spawnHookResponse(body);
  } catch {}
}
