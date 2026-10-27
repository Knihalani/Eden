import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIR = new Set(["node_modules", "dist", ".next", ".git", ".gauntlet", "archived", "coverage"]);

export const PATH_ALLOWLIST = new Set([
  "EDEN_AGENT",
  "EDEN_API_KEY",
  "EDEN_BASE_URL",
  "EDEN_CONTROL_TIMEOUT_MS",
  "EDEN_DB",
  "EDEN_DEBUG_FORK",
  "EDEN_DEBUG_ISLANDS",
  "EDEN_DEV",
  "EDEN_FLAKE_CLOCK_OFFSET_MS",
  "EDEN_FLAKE_CLOCK_SCALE",
  "EDEN_FLAKE_CLOCK_VERBOSE",
  "EDEN_FORGE_HOST",
  "EDEN_GH_OWNER",
  "EDEN_GH_REPO",
  "EDEN_HOME",
  "EDEN_HOOKD_HOST",
  "EDEN_HOOKD_PORT",
  "EDEN_HOOKD_TIMEOUT_MS",
  "EDEN_ISLAND_BATCH_POLL_MS",
  "EDEN_ISLAND_MS",
  "EDEN_KNOW_DIR",
  "EDEN_LIST_MCP",
  "EDEN_LIVE_INVOICE",
  "EDEN_MIN_LLM_REDUCTION",
  "EDEN_NO_CODING",
  "EDEN_ORG",
  "EDEN_ORIGIN",
  "EDEN_PUBLIC_URL",
  "EDEN_RUNNER_ISLANDS",
  "EDEN_RUNNER_POLL_MS",
  "EDEN_SETUP_TOKEN",
  "EDEN_SITE_MCP",
  "EDEN_SITE_URL",
  "EDEN_SKIP_SEED",
  "EDEN_SOAK_CALLS",
  "EDEN_STRESS",
  "EDEN_SUB_TIMEOUT_MS",
  "EDEN_TEST_WEBHOOK",
  "EDEN_UPSTREAM_TIMEOUT_MS",
  "EDEN_WRAP_HOST",
  "EDEN_WRAP_URL",
]);

export const WAVE_16_19_SWITCHES = [
  "EDEN_NET_ALLOW",
  "EDEN_WEBHOOK_RAW",
  "EDEN_HOOKD",
  "EDEN_SURFACE",
  "EDEN_AUTO_APPROVE",
] as const;

export function edenNamesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bEDEN_[A-Z][A-Z0-9_]*\b/g)) out.add(m[0]!);
  return [...out].sort();
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function productionEnvNamesIn(text: string): string[] {
  const src = withoutComments(text);
  const out = new Set<string>();
  for (const m of src.matchAll(/process\.env\.EDEN_[A-Z][A-Z0-9_]*/g)) {
    out.add(m[0]!.slice("process.env.".length));
  }
  for (const m of src.matchAll(/["'](EDEN_[A-Z][A-Z0-9_]*)["']/g)) {
    out.add(m[1]!);
  }
  return [...out].sort();
}

export function section15Switches(roadmap: string): Set<string> {
  const section = roadmap.split("## 15. Kill-switch inventory")[1]?.split("\n## 16.")[0] ?? "";
  return new Set(edenNamesIn(section));
}

function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !name.includes(".test.")) acc.push(p);
  }
}

export function productionEdenNames(root: string): string[] {
  const files: string[] = [];
  for (const top of ["apps", "packages", "benchmarks"]) {
    const p = join(root, top);
    try {
      walk(p, files);
    } catch {}
  }
  const names = new Set<string>();
  for (const f of files) {
    const rel = relative(root, f);
    if (rel.includes("/scripts/")) continue;
    if (rel.endsWith("/switches.ts") || rel.endsWith("/switches.test.ts")) continue;
    const text = withoutComments(readFileSync(f, "utf8"));
    for (const n of productionEnvNamesIn(text)) names.add(n);
  }
  return [...names].sort();
}

export function undocumentedSwitches(roadmap: string, root: string): string[] {
  const documented = section15Switches(roadmap);
  return productionEdenNames(root).filter((n) => !documented.has(n) && !PATH_ALLOWLIST.has(n));
}
