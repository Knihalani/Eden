import { join } from "node:path";
import { homedir } from "node:os";
import { Store, createHandler } from "@eden/control";
import { ensureHome, resolveApiKey } from "./home";
import { codingRegistry, wrapIsland } from "@eden/wrap";

export function wrapRegistry(args: string[]) {
  if (args.includes("--no-coding")) return undefined;
  return codingRegistry(arg(args, "--cwd") || process.cwd());
}

export function wrapListen(args: string[]): { port: number; hostname: string } {
  return {
    port: Number(arg(args, "--port") || process.env.PORT || 8788),
    hostname: arg(args, "--host") || process.env.EDEN_WRAP_HOST || "127.0.0.1",
  };
}

export async function wrapCmd(args: string[]): Promise<void> {
  ensureHome();
  const { port, hostname } = wrapListen(args);
  const db = process.env.EDEN_DB || join(process.env.EDEN_HOME || join(homedir(), ".eden"), "control.sqlite");
  const store = new Store(db);
  const token = resolveApiKey(args);
  const upstream = process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL;
  const fetchHandler = createHandler({
    store,
    token,
    upstream,
    upstreamKey: process.env.OPENAI_API_KEY,
    registry: wrapRegistry(args),
    island: wrapIsland({ apiKey: process.env.OPENAI_API_KEY, upstream }),
  });
  const server = Bun.serve({ port, hostname, fetch: fetchHandler });
  console.log(`Eden wrap ${server.url}`);
  console.log(`OPENAI_BASE_URL=${new URL("/v1", server.url).href}`);
  console.log("UI: bun run --cwd apps/web dev");
  console.log("Ships from 2× fewer LLM calls");
  await new Promise(() => undefined);
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
