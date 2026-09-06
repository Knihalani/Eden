#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

async function findRun(): Promise<(() => Promise<void>) | undefined> {
  const files: string[] = [];
  const roots = [process.env.CLAUDE_PLUGIN_ROOT, process.env.EDEN_ROOT, import.meta.dir].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  for (const start of roots) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      files.push(join(dir, "packages/cli/src/memory-hook.ts"));
      files.push(join(dir, "cli/src/memory-hook.ts"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const p of files) {
    if (!existsSync(p)) continue;
    try {
      const mod = (await import(p)) as { runMemoryHookStdin?: () => Promise<void> };
      if (typeof mod.runMemoryHookStdin === "function") return mod.runMemoryHookStdin;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

const run = await findRun();
if (run) await run();
else process.stdout.write("{}");
