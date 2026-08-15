import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig, edenHome } from "./home";

export async function openTool(): Promise<void> {
  const cfg = readConfig();
  const base = cfg?.base_url || "http://127.0.0.1:8787";
  const knockPath = join(edenHome(), "knock.json");
  const knock = existsSync(knockPath) ? (JSON.parse(readFileSync(knockPath, "utf8")) as { tool_id?: string }) : {};
  const url = knock.tool_id ? `${base}/workshop/${knock.tool_id}` : `${base}/workshop`;
  Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  console.log(url);
}

export async function rejectTool(): Promise<void> {
  const cfg = readConfig();
  const base = cfg?.base_url || "http://127.0.0.1:8787";
  const key = cfg?.api_key || "eden_dev";
  await fetch(`${base}/v1/knock/reject`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
  });
  const knock = join(edenHome(), "knock.json");
  if (existsSync(knock)) unlinkSync(knock);
  console.log("rejected");
}
