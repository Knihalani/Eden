#!/usr/bin/env bun
/**
 * The eden-memory plugin's hook, for every event: loads the memory hook of an Eden checkout (`eden-root.ts`) into
 * this process and runs it. When Eden cannot load, the hook fails open: exit 0, nothing printed, and the cause
 * logged once (`fallback-log.ts`). There is no slower path to fall back to, so no daemon and no spawn: every path
 * stays inside the 150 ms Submit budget (D20). Stop's two handlers name their stage as the first argument (D34:
 * `stop-fast`, `stop-sleep`).
 */
import { dirname, join } from "node:path";
import { findEdenRoot, MEMORY_HOOK } from "./eden-root";
import { logFallbackOnce } from "./fallback-log";

type MemoryHook = { runMemoryHookStdin: (stage?: string) => Promise<void> };

const pluginRoot = dirname(import.meta.dir);
try {
  const { root } = findEdenRoot(pluginRoot);
  const { runMemoryHookStdin } = (await import(join(root, MEMORY_HOOK))) as MemoryHook;
  await runMemoryHookStdin(process.argv[2]);
} catch (err) {
  try {
    logFallbackOnce(pluginRoot, err instanceof Error ? err.message : String(err));
  } catch {}
}
