#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

async function run() {
  for (const p of [
    "../../../packages/cli/src/memory-hook.ts",
    process.env.EDEN_ROOT && `${process.env.EDEN_ROOT}/packages/cli/src/memory-hook.ts`,
  ].filter(Boolean) as string[]) {
    try {
      const { runMemoryHookStdin } = await import(p);
      await runMemoryHookStdin();
      return;
    } catch {}
  }
  const body = await new Promise<string>((r) => {
    const c: Buffer[] = [];
    process.stdin.on("data", (b) => c.push(b as Buffer));
    process.stdin.on("end", () => r(Buffer.concat(c).toString("utf8")));
    if (process.stdin.isTTY) r("{}");
  });
  try {
    // hookd's per-install key: one `name: value` header line, 0600 in the Eden home. No key, no hookd.
    const keyFile = join(process.env.EDEN_HOME || join(homedir(), ".eden"), "hookd.key");
    const [name, value] = readFileSync(keyFile, "utf8").trim().split(/:\s*/, 2);
    const res = await fetch(`http://127.0.0.1:${process.env.EDEN_HOOKD_PORT || 8794}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", [name!]: value! },
      body: body || "{}",
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      process.stdout.write(await res.text());
      return;
    }
  } catch {}
  for (const cmd of [
    ["eden", "hook"],
    process.env.EDEN_ROOT ? ["bun", `${process.env.EDEN_ROOT}/packages/cli/src/cli.ts`, "hook"] : [],
    ["bun", `${import.meta.dir}/../../../packages/cli/src/cli.ts`, "hook"],
  ].filter((c) => c.length)) {
    try {
      const r = Bun.spawnSync(cmd, {
        stdin: new TextEncoder().encode(body || "{}"),
        stdout: "pipe",
        stderr: "ignore",
        timeout: 8000,
      });
      if (r.success && r.stdout.byteLength) {
        process.stdout.write(r.stdout);
        return;
      }
    } catch {}
  }
  process.stdout.write("{}");
}
await run();
