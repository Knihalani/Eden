import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { respondToHook, type HookIn } from "./hook";
import { edenHome, ensureHome, withFileLockAsync } from "./home";

export function hookdPidPath(): string {
  return join(edenHome(), "hookd.pid");
}

export function writeHookdPid(pid = process.pid): void {
  ensureHome();
  writeFileSync(hookdPidPath(), `${pid}\n`);
}

export function readHookdPid(): number | null {
  try {
    const n = Number(readFileSync(hookdPidPath(), "utf8").trim());
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } catch {
    return null;
  }
}

export function hookdPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function clearHookdPid(): void {
  try {
    if (existsSync(hookdPidPath())) unlinkSync(hookdPidPath());
  } catch {
    /* best-effort */
  }
}

export function parseHookdHealthPid(j: unknown): number | null {
  if (!j || typeof j !== "object") return null;
  const n = Number((j as { pid?: unknown }).pid);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export async function fetchHookdHealth(timeoutMs = 200): Promise<{ ok: boolean; pid: number | null }> {
  const port = process.env.EDEN_HOOKD_PORT || "8794";
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, pid: null };
    const j = (await r.json()) as { service?: string; pid?: unknown };
    if (j.service !== "eden-hookd") return { ok: false, pid: null };
    return { ok: true, pid: parseHookdHealthPid(j) };
  } catch {
    return { ok: false, pid: null };
  }
}

export async function stopHookd(): Promise<number> {
  const recorded = readHookdPid();
  const live = (await fetchHookdHealth(400)).pid;
  const target = live ?? recorded;
  if (!target) {
    console.error("eden hookd: not running");
    return 0;
  }
  if (!live && recorded && !hookdPidAlive(recorded)) {
    clearHookdPid();
    console.error("eden hookd: not running");
    return 0;
  }
  try {
    process.kill(target, "SIGTERM");
  } catch {
    /* already gone */
  }
  clearHookdPid();
  if (live) {
    const extra = recorded && recorded !== live ? `; pid file was ${recorded}` : "";
    console.error(`eden hookd: stopped ${live} (live /health pid${extra})`);
    for (let i = 0; i < 40; i++) {
      if (!(await hookdHealthy(80))) break;
      await Bun.sleep(25);
    }
  } else {
    console.error(`eden hookd: stopped ${recorded} (pid file)`);
  }
  return 0;
}

export function hookdTimeoutMs(): number {
  const n = Number(process.env.EDEN_HOOKD_TIMEOUT_MS || 8000);
  return Number.isFinite(n) ? Math.min(60_000, Math.max(500, n)) : 8000;
}

function looksBrowserDriven(req: Request): boolean {
  if (req.headers.get("origin")) return true;
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "none";
}

function hostIsLoopback(req: Request): boolean {
  const raw = req.headers.get("host");
  if (!raw) return true;
  const host = raw.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

export async function handleHookd(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === "GET" && path === "/health") {
    return Response.json({ ok: true, service: "eden-hookd", pid: process.pid });
  }
  if (req.method !== "POST") {
    return Response.json({});
  }
  if (looksBrowserDriven(req) || !hostIsLoopback(req)) {
    return Response.json({}, { status: 403 });
  }
  if (path !== "/hook" && path !== "/") {
    return Response.json({}, { status: 404 });
  }
  let input: HookIn = {};
  try {
    input = (await req.json()) as HookIn;
  } catch {
    return Response.json({});
  }
  const done = enqueue(input);
  try {
    const out = await done;
    return Response.json(out);
  } catch (err) {
    process.stderr.write(`eden hookd: ${(err as Error)?.message ?? String(err)}\n`);
    return Response.json({});
  }
}

let tail: Promise<unknown> = Promise.resolve();
function enqueue(input: HookIn): Promise<Record<string, unknown>> {
  const work = tail.then(
    () => Promise.resolve(respondToHook(input, withFileLockAsync)),
    () => Promise.resolve(respondToHook(input, withFileLockAsync)),
  );
  tail = work.catch(() => undefined);
  return Promise.race([
    work,
    new Promise<Record<string, never>>((_, reject) => {
      const t = setTimeout(() => reject(new Error("hookd timeout")), hookdTimeoutMs());
      t.unref?.();
    }),
  ]);
}

export async function hookdHealthy(timeoutMs = 200): Promise<boolean> {
  return (await fetchHookdHealth(timeoutMs)).ok;
}

export async function waitForHookdHealth(attempts = 15): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await hookdHealthy()) return true;
    if (i + 1 < attempts) await Bun.sleep(50);
  }
  return false;
}

export async function startHookdBackground(): Promise<boolean> {
  if (process.env.EDEN_HOOKD === "0") return false;
  try {
    if (await hookdHealthy()) return false;
    ensureHome();
    return await withFileLockAsync(`${hookdPidPath()}.lock`, async () => {
      if (await hookdHealthy()) return false;
      const existing = readHookdPid();
      if (existing && !hookdPidAlive(existing)) clearHookdPid();
      const child = Bun.spawn(hookdSpawnCmd(), {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: { ...process.env },
      });
      const spawned = child.pid;
      if (spawned) writeHookdPid(spawned);
      child.unref();
      const ok = await waitForHookdHealth();
      if (!ok) {
        if (spawned && readHookdPid() === spawned) clearHookdPid();
        try {
          if (spawned) process.kill(spawned, "SIGTERM");
        } catch {
          /* already gone */
        }
        return false;
      }
      return true;
    });
  } catch {
    return false;
  }
}

function hookdSpawnCmd(): string[] {
  const sibling = join(import.meta.dir, "hookd.ts");
  if (existsSync(sibling)) return [process.execPath, sibling];
  const argv1 = process.argv[1];
  if (argv1) return [process.execPath, argv1, "hookd"];
  return [process.execPath, join(import.meta.dir, "cli.ts"), "hookd"];
}

export async function runHookd(args: string[] = []): Promise<void> {
  if (args.includes("--stop")) {
    process.exit(await stopHookd());
  }
  const port = Number(process.env.EDEN_HOOKD_PORT || 8794);
  const hostname = process.env.EDEN_HOOKD_HOST || "127.0.0.1";
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname,
      fetch: handleHookd,
    });
  } catch (err) {
    process.stderr.write(`eden hookd: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(1);
  }
  writeHookdPid();
  console.error(`eden hookd ${server.url}`);
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    server.stop(false);
    clearHookdPid();
    void tail.then(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref?.();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await new Promise(() => undefined);
}

if (import.meta.main) await runHookd(process.argv.slice(2));
