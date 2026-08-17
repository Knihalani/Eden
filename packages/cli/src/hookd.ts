import { respondToHook, type HookIn } from "./hook";

export function hookdTimeoutMs(): number {
  const n = Number(process.env.EDEN_HOOKD_TIMEOUT_MS || 8000);
  return Number.isFinite(n) ? Math.min(60_000, Math.max(500, n)) : 8000;
}

export async function handleHookd(req: Request): Promise<Response> {
  if (req.method === "GET" && new URL(req.url).pathname === "/health") {
    return Response.json({ ok: true, service: "eden-hookd" });
  }
  if (req.method !== "POST") {
    return Response.json({});
  }
  let input: HookIn = {};
  try {
    input = (await req.json()) as HookIn;
  } catch {
    return Response.json({});
  }
  try {
    const out = await Promise.race([
      Promise.resolve(respondToHook(input)),
      new Promise<Record<string, never>>((_, reject) => {
        const t = setTimeout(() => reject(new Error("hookd timeout")), hookdTimeoutMs());
        t.unref?.();
      }),
    ]);
    return Response.json(out);
  } catch {
    return Response.json({});
  }
}

export async function runHookd(): Promise<void> {
  const port = Number(process.env.EDEN_HOOKD_PORT || 8794);
  const hostname = process.env.EDEN_HOOKD_HOST || "127.0.0.1";
  const server = Bun.serve({
    port,
    hostname,
    fetch: handleHookd,
  });
  console.error(`eden hookd ${server.url}`);
  await new Promise(() => undefined);
}

if (import.meta.main) await runHookd();
