#!/usr/bin/env bun
/**
 * The eden-memory plugin's hook, for every event: loads the memory hook of an Eden checkout (`eden-root.ts`) into
 * this process and runs it. When Eden cannot load, the hook fails open: exit 0, nothing printed, and the cause
 * logged once (`fallback-log.ts`). There is no slower path to fall back to, so no daemon and no spawn: every path
 * stays inside the 150 ms Submit budget (D20). Stop's two handlers name their stage as the first argument (D34:
 * `stop-fast`, `stop-sleep`). The PreToolUse guard's handlers name `guard`: their call is re-checked against every
 * action class before the guard's hook loads, so a call no class is (`git status`, `bun test`) costs only this process
 * (A7 §5, `memory-guard-match.ts`). The `PreToolUse(Agent)` handler names `spawn`: it records the launch for the
 * subagent's SubagentStart (A4 §5.3, `memory-spawn-hook.ts`) and prints nothing.
 */
import { dirname, join } from "node:path";
import { findEdenRoot, GUARD_HOOK, GUARD_MATCH, MEMORY_HOOK, SPAWN_HOOK } from "./eden-root";
import { logFallbackOnce } from "./fallback-log";

type MemoryHook = { runMemoryHookStdin: (stage?: string) => Promise<void> };
type GuardMatch = { guardedCall: (payload: Record<string, unknown>) => boolean };
type GuardHook = { runGuardHook: (payload: Record<string, unknown>) => void };
type SpawnHook = { runSpawnHook: (payload: Record<string, unknown>) => void };

/** The hook payload on stdin; `{}` when it is not a JSON object. */
async function payload(): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse((await Bun.stdin.text()) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const pluginRoot = dirname(import.meta.dir);
const stage = process.argv[2];
try {
  const { root } = findEdenRoot(pluginRoot);
  if (stage === "guard") {
    const body = await payload();
    const { guardedCall } = (await import(join(root, GUARD_MATCH))) as GuardMatch;
    if (guardedCall(body)) ((await import(join(root, GUARD_HOOK))) as GuardHook).runGuardHook(body);
  } else if (stage === "spawn") {
    ((await import(join(root, SPAWN_HOOK))) as SpawnHook).runSpawnHook(await payload());
  } else {
    const { runMemoryHookStdin } = (await import(join(root, MEMORY_HOOK))) as MemoryHook;
    await runMemoryHookStdin(stage);
  }
} catch (err) {
  try {
    logFallbackOnce(pluginRoot, err instanceof Error ? err.message : String(err));
  } catch {}
}
