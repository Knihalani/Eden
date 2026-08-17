import { resolveApiKey } from "./home";

export function mcpHeaders(): void {
  let key: string | undefined;
  try {
    key = resolveApiKey(process.argv.slice(2));
  } catch {
    key = undefined;
  }
  if (!key) {
    process.stdout.write("{}\n");
    return;
  }
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${key}` }) + "\n");
}

if (import.meta.main) mcpHeaders();
