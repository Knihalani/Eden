import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";
import { createHandler } from "./server";
import { codingRegistry, wrapIsland } from "@eden/wrap";
import { startHookdBackground } from "../../../packages/cli/src/hookd";
import { wrapBootLetter } from "../../../packages/cli/src/wrap-cmd";

if (await startHookdBackground()) {
  console.log("Recording daemon starting (`eden hookd`). Stop with `eden hookd --stop`.");
}

const PORT = Number(process.env.PORT || 8788);
const db = process.env.EDEN_DB || join(process.env.EDEN_HOME || join(homedir(), ".eden"), "control.sqlite");
const store = new Store(db);
const upstream = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const fetchHandler = createHandler({
  store,
  token: process.env.EDEN_API_KEY || "eden_dev",
  upstream,
  upstreamKey: process.env.OPENAI_API_KEY,
  registry: process.env.EDEN_NO_CODING === "1" ? undefined : codingRegistry(process.cwd()),
  island: wrapIsland({ apiKey: process.env.OPENAI_API_KEY, upstream }),
  scheduleClock: true,
});
const server = Bun.serve({ port: PORT, hostname: process.env.EDEN_WRAP_HOST || "127.0.0.1", fetch: fetchHandler });
console.log(wrapBootLetter(String(server.url), store.liveCount()));
