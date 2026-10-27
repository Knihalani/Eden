import { homedir } from "node:os";
import { join } from "node:path";
import { Store, createHandler, replayRegistry } from "@eden/control";

type WrapFetch = (req: Request) => Promise<Response>;

const g = globalThis as typeof globalThis & { __edenStore?: Store; __edenWrap?: WrapFetch };

export function wrapFetch(): WrapFetch {
  const db =
    process.env.EDEN_DB ||
    (process.env.VERCEL
      ? "/tmp/eden-control.sqlite"
      : join(process.env.EDEN_HOME || join(homedir(), ".eden"), "control.sqlite"));
  if (!g.__edenStore) g.__edenStore = new Store(db);
  if (g.__edenWrap) return g.__edenWrap;
  g.__edenWrap = createHandler({
    store: g.__edenStore,
    token: process.env.EDEN_API_KEY || "eden_dev",
    upstream: process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL,
    upstreamKey: process.env.OPENAI_API_KEY,
    sandboxFor: (t) => replayRegistry(undefined, t),
  });
  return g.__edenWrap;
}
