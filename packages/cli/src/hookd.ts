import { respondToHook, type HookIn } from "./hook";

export async function runHookd(): Promise<void> {
  const port = Number(process.env.EDEN_HOOKD_PORT || 8794);
  const hostname = process.env.EDEN_HOOKD_HOST || "127.0.0.1";
  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      if (req.method === "GET" && new URL(req.url).pathname === "/health") {
        return new Response("ok");
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
          respondToHook(input),
          new Promise<Record<string, never>>((_, reject) => {
            setTimeout(() => reject(new Error("hookd timeout")), 1500);
          }),
        ]);
        return Response.json(out);
      } catch {
        return Response.json({});
      }
    },
  });
  console.error(`eden hookd ${server.url}`);
  await new Promise(() => undefined);
}

if (import.meta.main) await runHookd();
