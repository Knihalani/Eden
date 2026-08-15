import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readConfig, edenHome } from "./home";

export async function openTool(): Promise<void> {
  const cfg = readConfig();
  const base = cfg?.base_url || "http://127.0.0.1:8787";
  const url = `${base}/workshop`;
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
