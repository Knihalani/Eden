/**
 * K13 merge polish — structural tests used to read monolithic ``lib/api.ts``.
 * API surface now lives under ``lib/api/*.ts``; concatenate for grep-style asserts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function readApiModules(portalRoot: string): string {
  const dir = resolve(portalRoot, "src/lib/api");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .join("\n");
}
