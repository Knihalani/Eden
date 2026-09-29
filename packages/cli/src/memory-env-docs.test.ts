/**
 * M49.4 — docs pin. Operator env names in the CLI and plugin READMEs
 * must appear as process.env.* in product code. Not a ranker test.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "../../..");
const cliReadme = readFileSync(join(root, "packages/cli/README.md"), "utf8");
const pluginReadme = readFileSync(join(root, "plugins/eden-memory/README.md"), "utf8");

const PRODUCT_ROOTS = ["src", "packages/cli/src", "packages/wrap/src"];

function productSource(): string {
  const chunks: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) chunks.push(readFileSync(path, "utf8"));
    }
  };
  for (const rel of PRODUCT_ROOTS) walk(join(root, rel));
  return chunks.join("\n");
}

const ENV_IN_DOCS = /EDEN_(?:MEMORY|SLEEP)[A-Z0-9_]*/g;

function envNames(text: string): string[] {
  return [...new Set(text.match(ENV_IN_DOCS) ?? [])];
}

describe("M49.4 memory env docs", () => {
  test("CLI README names the floor, sleep, import, and three states", () => {
    for (const needle of ["EDEN_MEMORY_MIN", "EDEN_SLEEP_EVERY", "EDEN_SLEEP_IDLE", "EDEN_SLEEP_BUDGET", "eden memory import"]) {
      expect(cliReadme).toContain(needle);
    }
    expect(cliReadme).toMatch(/\bon\b/);
    expect(cliReadme).toMatch(/\bread-only\b/);
    expect(cliReadme).toMatch(/\boff\b/);
  });

  test("plugin README keeps three states, the floor, and sleep names", () => {
    for (const needle of ["EDEN_MEMORY_MIN", "EDEN_SLEEP_EVERY", "EDEN_SLEEP_IDLE", "EDEN_SLEEP_BUDGET", "readonly", "off"]) {
      expect(pluginReadme).toContain(needle);
    }
    expect(pluginReadme).toMatch(/\bon\b/);
  });

  test("every operator EDEN_MEMORY / EDEN_SLEEP name in the READMEs exists in product code", () => {
    const src = productSource();
    const names = [...new Set([...envNames(cliReadme), ...envNames(pluginReadme)])];
    expect(names.length).toBeGreaterThan(0);
    const missing = names.filter((name) => !src.includes(`process.env.${name}`));
    expect(missing).toEqual([]);
    const inCode = envNames(src).filter((name) => src.includes(`process.env.${name}`));
    const undocumented = inCode.filter((name) => !cliReadme.includes(name) || !pluginReadme.includes(name));
    expect(undocumented).toEqual([]);
  });
});
