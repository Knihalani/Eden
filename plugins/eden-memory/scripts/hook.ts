#!/usr/bin/env bun
async function run() {
  for (const p of ["../../../packages/cli/src/memory-hook.ts", process.env.EDEN_ROOT && `${process.env.EDEN_ROOT}/packages/cli/src/memory-hook.ts`].filter(Boolean) as string[]) {
    try { const { runMemoryHookStdin } = await import(p); await runMemoryHookStdin(); return; } catch {}
  }
  const body = await new Promise<string>((r) => {
    const c: Buffer[] = [];
    process.stdin.on("data", (b) => c.push(b as Buffer));
    process.stdin.on("end", () => r(Buffer.concat(c).toString("utf8")));
    if (process.stdin.isTTY) r("{}");
  });
  try {
    process.stdout.write(await (await fetch(`http://127.0.0.1:${process.env.EDEN_HOOKD_PORT || 8794}/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: body || "{}", signal: AbortSignal.timeout(8000) })).text());
    return;
  } catch {}
  for (const cmd of [["eden", "hook"], process.env.EDEN_ROOT ? ["bun", `${process.env.EDEN_ROOT}/packages/cli/src/cli.ts`, "hook"] : [], ["bun", `${import.meta.dir}/../../../packages/cli/src/cli.ts`, "hook"]].filter((c) => c.length)) {
    try {
      const r = Bun.spawnSync(cmd, { stdin: new TextEncoder().encode(body || "{}"), stdout: "pipe", stderr: "ignore", timeout: 8000 });
      if (r.success && r.stdout.byteLength) { process.stdout.write(r.stdout); return; }
    } catch {}
  }
  process.stdout.write("{}");
}
await run();
