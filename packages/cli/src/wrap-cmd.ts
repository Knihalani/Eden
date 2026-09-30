import { join } from "node:path";
import { homedir } from "node:os";
import { Store, createHandler } from "@eden/control";
import { configPath, ensureHome, resolveApiKey, resolveWrapKey, type WrapKey } from "./home";
import { codingRegistry, wrapIsland } from "@eden/wrap";
import { replayRegistry } from "@eden/shadow";

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

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

/** Saves a new per-install key once the server holds its port, and says where. */
export function keepWrapKey(wrapKey: WrapKey, origin: string): void {
  if (!wrapKey.save) return;
  if (!wrapKey.save(origin.replace(/\/$/, ""))) {
    throw new Error("another eden wrap saved a key first; start eden wrap again");
  }
  const replaced = wrapKey.replacesDevKey ? ", replacing the public eden_dev" : "";
  console.log(`Saved a per-install wrap key in ${configPath()} (mode 0600)${replaced}. eden clients read it there.`);
}

export function wrapHelp(): string {
  return `eden wrap — local proxy

  eden wrap              Start the local proxy at 127.0.0.1:8788
  eden wrap --help       This letter; does not start the proxy
  eden wrap --dev        Use the public eden_dev key when no key is set (dev and tests only)

Point an agent at OPENAI_BASE_URL=http://127.0.0.1:8788/v1
Keep OPENAI_API_KEY as the model key. An Eden key is wrap auth for /v1/wrap, not OpenAI.
The Eden key is --key, EDEN_API_KEY or eden login. Without one, the first loopback start writes a
per-install key to ~/.eden/config.json (mode 0600); eden commands and the SDKs read it there.
A compiled hit plays without a model key (model: eden). Miss without a key fail-opens as HTTP 200 (model: eden), not 502.
Wrap reaches the model at api.openai.com (override: OPENAI_API_BASE).
SDK (JS/Python): POST /v1/wrap then POST /v1/ingest — miss is original, wrap down is original
Does not Approve. Live tools stay 0 until a human Approve. T-100 is eden demo.
`;
}

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
  const local = isLoopbackHost(hostname) && !process.env.VERCEL;
  const wrapKey: WrapKey = local ? resolveWrapKey(args) : { key: resolveApiKey(args) };
  const token = wrapKey.key;
  if (token === "eden_dev" && !args.includes("--dev") && process.env.EDEN_DEV !== "1") {
    // Most often an old repo-root .env (Bun loads it) that still says EDEN_API_KEY=eden_dev.
    console.error(
      "eden wrap: /v1 accepts the public eden_dev key (from --key, EDEN_API_KEY, .env or config.json). " +
        "Unset it for a per-install key, or pass --dev if this is deliberate.",
    );
  }
  // A laptop often has DATABASE_URL set for the hosted site, which reads as a managed install.
  // Loopback wrap is a local install. This runs after the key is chosen, so it never picks eden_dev.
  if (local && process.env.EDEN_DEV !== "0") {
    process.env.EDEN_DEV = process.env.EDEN_DEV || "1";
  }
  const db = process.env.EDEN_DB || join(process.env.EDEN_HOME || join(homedir(), ".eden"), "control.sqlite");
  const store = new Store(db);
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
  keepWrapKey(wrapKey, String(server.url));
  console.log(wrapBootLetter(String(server.url), store.liveCount()));
  await new Promise(() => undefined);
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
