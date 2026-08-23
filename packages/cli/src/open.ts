import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readConfig, edenHome, resolveApiKey, sitePlaneUrl, readJson } from "./home";

export async function openTool(): Promise<void> {
  const cfg = readConfig();
  const base = sitePlaneUrl(cfg?.base_url);
  const knockPath = join(edenHome(), "knock.json");
  // A half-written or corrupt knock.json used to throw straight out of
  // JSON.parse; it is advisory data, so a bad file just means the plain
  // workshop URL — same guard drain uses for its reads.
  const knock = readJson<{ tool_id?: string }>(knockPath, {});
  const url = knock.tool_id ? `${base}/workshop/${knock.tool_id}` : `${base}/workshop`;
  Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  console.log(url);
}

export async function rejectTool(): Promise<void> {
  const cfg = readConfig();
  const base = sitePlaneUrl(cfg?.base_url);
  const key = resolveApiKey();
  await fetch(`${base}/v1/knock/reject`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
  });
  const knock = join(edenHome(), "knock.json");
  if (existsSync(knock)) unlinkSync(knock);
  console.log("rejected");
}
