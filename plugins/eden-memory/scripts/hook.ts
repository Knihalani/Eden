#!/usr/bin/env bun
/**
 * The eden-memory plugin's hook, for every event: loads the memory hook of an Eden checkout (`eden-root.ts`) into
 * this process and runs it. When Eden cannot load, the hook fails open: exit 0, nothing printed, and the cause
 * logged once (`fallback-log.ts`). There is no slower path to fall back to, so no daemon and no spawn: every path
 * stays inside the 150 ms Submit budget (D20). Stop's two handlers name their stage as the first argument (D34:
 * `stop-fast`, `stop-sleep`); the PreToolUse guard's handlers name `guard` and their class (A7 §5).
 */
import { dirname, join } from "node:path";
import { findEdenRoot, GUARD_HOOK, MEMORY_HOOK } from "./eden-root";
import { logFallbackOnce } from "./fallback-log";

type MemoryHook = { runMemoryHookStdin: (stage?: string) => Promise<void> };
type GuardHook = { runGuardHookStdin: (cls?: string) => Promise<void> };

const pluginRoot = dirname(import.meta.dir);
const [stage, cls] = process.argv.slice(2);
try {
  const { root } = findEdenRoot(pluginRoot);
  if (stage === "guard") {
    const { runGuardHookStdin } = (await import(join(root, GUARD_HOOK))) as GuardHook;
    await runGuardHookStdin(cls);
  } else {
    const { runMemoryHookStdin } = (await import(join(root, MEMORY_HOOK))) as MemoryHook;
    await runMemoryHookStdin(stage);
  }
} catch (err) {
  try {
    logFallbackOnce(pluginRoot, err instanceof Error ? err.message : String(err));
  } catch {}
}
