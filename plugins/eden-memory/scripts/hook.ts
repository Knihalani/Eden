#!/usr/bin/env bun
try {
  const { runMemoryHookStdin } = await import("../../../packages/cli/src/memory-hook.ts");
  await runMemoryHookStdin();
} catch {
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
