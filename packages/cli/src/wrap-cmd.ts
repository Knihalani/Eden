import { join } from "node:path";
import { homedir } from "node:os";
import { Store, createHandler } from "@eden/control";
import { ensureHome, resolveApiKey } from "./home";
import { codingRegistry, wrapIsland } from "@eden/wrap";
import { replayRegistry } from "@eden/shadow";

/** Bring up hookd so Claude Code's 1s PreToolUse curl can deny remainder. */
export async function bootHookdFromWrap(): Promise<boolean> {
  const { startHookdBackground } = await import("./hookd");
  return startHookdBackground();
}

export function wrapRegistry(args: string[]) {
  if (args.includes("--no-coding")) return undefined;
  return codingRegistry(arg(args, "--cwd") || process.cwd());
}

export function wrapListen(args: string[]): { port: number; hostname: string } {
  // `||` used to swallow an explicit `--port 0` (ephemeral), and
  // Number("887o") sailed NaN into Bun.serve. Parse, then validate.
  const raw = arg(args, "--port") ?? process.env.PORT ?? "8788";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid --port: ${raw}`);
  }
  return {
    port,
    hostname: arg(args, "--host") || process.env.EDEN_WRAP_HOST || "127.0.0.1",
  };
}

export async function wrapCmd(args: string[]): Promise<void> {
  ensureHome();
  if (await bootHookdFromWrap()) {
    console.log("Recording daemon starting (`eden hookd`). Stop with `eden hookd --stop`.");
  }
  const { port, hostname } = wrapListen(args);
  const db = process.env.EDEN_DB || join(process.env.EDEN_HOME || join(homedir(), ".eden"), "control.sqlite");
  const store = new Store(db);
  const token = resolveApiKey(args);
  const upstream = process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL;
  const registry = wrapRegistry(args);
  // A laptop registry executes runner steps (Bash/cwd/fs), so locally a
  // pure-CLI stretch — kubectl, aws, psql — may compile. Hosted MCP keeps
  // the cloud-only default because it cannot play runner steps.
  process.env.EDEN_RUNNER_ISLANDS = "1";
  const fetchHandler = createHandler({
    store,
    token,
    upstream,
    upstreamKey: process.env.OPENAI_API_KEY,
    registry,
    sandboxFor: (t) => replayRegistry(registry, t),
    island: wrapIsland({ apiKey: process.env.OPENAI_API_KEY, upstream }),
    scheduleClock: true,
  });
  const server = Bun.serve({ port, hostname, fetch: fetchHandler });
  console.log(`Eden wrap ${server.url}`);
  console.log(`OPENAI_BASE_URL=${new URL("/v1", server.url).href}`);
  console.log("UI: bun run --cwd apps/web dev");
  console.log("Ships when quality holds and tokens or time are measured");
  await new Promise(() => undefined);
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
