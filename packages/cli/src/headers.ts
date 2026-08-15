import { readConfig } from "./home";

export function mcpHeaders(): void {
  const cfg = readConfig();
  const key = cfg?.api_key || process.env.EDEN_API_KEY || "eden_dev";
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${key}` }) + "\n");
}

if (import.meta.main) mcpHeaders();
