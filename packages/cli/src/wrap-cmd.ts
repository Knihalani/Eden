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

export function wrapHelp(): string {
  return `eden wrap — local proxy

  eden wrap              Start the local proxy at 127.0.0.1:8788
  eden wrap --help       This letter; does not start the proxy

Point an agent at OPENAI_BASE_URL=http://127.0.0.1:8788/v1
Keep OPENAI_API_KEY as the model key. An Eden key is wrap auth for /v1/wrap, not OpenAI.
A compiled hit plays without a model key (model: eden). Miss without a key fail-opens as HTTP 200 (model: eden), not 502.
Wrap reaches the model at api.openai.com (override: OPENAI_API_BASE).
SDK (JS/Python): POST /v1/wrap then POST /v1/ingest — miss is original, wrap down is original
Does not Approve. Live tools stay 0 until a human Approve. T-100 is eden demo.
`;
}

/** Printed after listen. Not the gated workbench. */
export function wrapBootLetter(origin: string, live = 0): string {
  const base = origin.replace(/\/$/, "");
  return `Eden wrap ${base}
OPENAI_BASE_URL=${base}/v1
Keep OPENAI_API_KEY as the model key. An Eden key is wrap auth, not OpenAI.
A compiled hit plays without a model key (model: eden). Miss without a key fail-opens as HTTP 200 (model: eden), not 502.
SDK  POST ${base}/v1/wrap  then  POST ${base}/v1/ingest
Does not Approve. Live tools: ${live} (0 until a human Approve). T-100 is eden demo.`;
}

export async function wrapCmd(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(wrapHelp());
    return;
  }
  ensureHome();
  if (await bootHookdFromWrap()) {
    console.log("Recording daemon starting (`eden hookd`). Stop with `eden hookd --stop`.");
  }
  const { port, hostname } = wrapListen(args);
  if (
    (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") &&
    !process.env.VERCEL &&
    process.env.EDEN_DEV !== "0"
  ) {
    process.env.EDEN_DEV = process.env.EDEN_DEV || "1";
  }
  const db = process.env.EDEN_DB || join(process.env.EDEN_HOME || join(homedir(), ".eden"), "control.sqlite");
  const store = new Store(db);
  const token = resolveApiKey(args);
  const upstream = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
  const registry = wrapRegistry(args);
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
  console.log(wrapBootLetter(String(server.url), store.liveCount()));
  await new Promise(() => undefined);
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
