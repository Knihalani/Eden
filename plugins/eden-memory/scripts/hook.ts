#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

async function findRun(): Promise<(() => Promise<void>) | undefined> {
  for (const start of [process.env.CLAUDE_PLUGIN_ROOT, process.env.EDEN_ROOT, import.meta.dir].filter(Boolean) as string[]) {
    for (let dir = start, i = 0; i < 8; i++, dir = dirname(dir)) {
      for (const p of [join(dir, "packages/cli/src/memory-hook.ts"), join(dir, "cli/src/memory-hook.ts")]) {
        if (!existsSync(p)) continue;
        try {
          const mod = (await import(p)) as { runMemoryHookStdin?: () => Promise<void> };
          if (typeof mod.runMemoryHookStdin === "function") return mod.runMemoryHookStdin;
        } catch {}
      }
      if (dirname(dir) === dir) break;
    }
  }
}

const run = await findRun();
if (run) await run();
else process.stdout.write("{}");
