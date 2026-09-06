import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readConfig, edenHome, resolveApiKey, sitePlaneUrl, readJson } from "./home";

export async function openTool(): Promise<void> {
  const cfg = readConfig();
  const base = sitePlaneUrl(cfg?.base_url);
  const knockPath = join(edenHome(), "knock.json");
  const knock = readJson<{ tool_id?: string }>(knockPath, {});
  const url = knockWorkshopUrl(base, knock);
  openBrowser(url);
  console.log(url);
}

export function knockWorkshopUrl(base: string, knock: { tool_id?: string } | null | undefined): string {
  const id = knock?.tool_id;
  return id ? `${base}/workshop/${id}` : `${base}/workshop`;
}

export function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    void proc.exited.catch(() => undefined);
  } catch {}
}

export async function rejectTool(): Promise<number> {
  const cfg = readConfig();
  if (!cfg) {
    console.log("reject: no config · run eden login --dev");
    return 1;
  }
  const base = sitePlaneUrl(cfg.base_url);
  const key = resolveApiKey();
  let down = false;
  try {
    const r = await fetch(`${base}/v1/knock/reject`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    down = !r.ok;
  } catch {
    down = true;
  }
  const knock = join(edenHome(), "knock.json");
  if (existsSync(knock)) unlinkSync(knock);
  console.log(down ? "reject: site is down · start eden wrap" : "rejected");
  return 0;
}
