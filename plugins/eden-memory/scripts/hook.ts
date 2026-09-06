#!/usr/bin/env bun
async function run() {
  for (const p of ["../../../packages/cli/src/memory-hook.ts", process.env.EDEN_ROOT && `${process.env.EDEN_ROOT}/packages/cli/src/memory-hook.ts`].filter(Boolean) as string[]) {
    try { const { runMemoryHookStdin } = await import(p); await runMemoryHookStdin(); return; } catch {}
  }
  try {
    const body = await new Promise<string>((r) => {
      const c: Buffer[] = [];
      process.stdin.on("data", (b) => c.push(b as Buffer));
      process.stdin.on("end", () => r(Buffer.concat(c).toString("utf8")));
      if (process.stdin.isTTY) r("{}");
    });
    process.stdout.write(await (await fetch(`http://127.0.0.1:${process.env.EDEN_HOOKD_PORT || 8794}/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: body || "{}", signal: AbortSignal.timeout(8000) })).text());
  } catch { process.stdout.write("{}"); }
}
await run();
