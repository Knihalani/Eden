/**
 * Oracle independence (EXECUTION X6, R9 §R1.4): product code never imports the harness, so it cannot read the
 * oracle, the annotated cues or the simulated window; and a run's oracle files sit outside everything a hook
 * is pointed at.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { hookEnv, loadPlugin } from "./runner";
import { PROBE_PLUGIN, removeTempDirs, tempDir } from "./testkit";

afterAll(removeTempDirs);

const REPO = join(import.meta.dir, "../../..");
/** Where product code lives: the memory library, the packages and apps, and the plugins. */
const PRODUCT = ["src", "packages", "apps", "plugins"];

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

/** An import, dynamic import or require of anything under the long-horizon harness. */
const IMPORTS_HARNESS = /(?:from|import|require)\s*\(?\s*["'][^"']*memory-long-horizon/;

describe("product code never reaches the harness", () => {
  test("the check recognizes every way of importing it", () => {
    expect(IMPORTS_HARNESS.test('import { Oracle } from "../../benchmarks/memory-long-horizon/harness/oracle";')).toBe(
      true,
    );
    expect(IMPORTS_HARNESS.test('await import("../benchmarks/memory-long-horizon/harness/metrics")')).toBe(true);
    expect(IMPORTS_HARNESS.test("require('../../benchmarks/memory-long-horizon/run')")).toBe(true);
    expect(IMPORTS_HARNESS.test('import { x } from "../benchmarks/campaign/provider-window";')).toBe(false);
  });

  test("no product file, test or source, imports the long-horizon harness", () => {
    const files = PRODUCT.flatMap((dir) => sources(join(REPO, dir)));
    expect(files.length).toBeGreaterThan(100);
    const reaching = files.filter((path) => IMPORTS_HARNESS.test(readFileSync(path, "utf8")));
    expect(reaching.map((path) => relative(REPO, path))).toEqual([]);
  });
});

describe("a hook is never pointed at the oracle files", () => {
  test("every path in the hook environment is inside the run's home or project, never its oracle directory", () => {
    const runDir = tempDir("eden-independence");
    const home = join(runDir, "home");
    const projectDir = join(runDir, "project");
    const env = hookEnv({ home, projectDir, plugin: loadPlugin(PROBE_PLUGIN) });
    const paths = Object.values(env).filter((value) => value.startsWith(runDir));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith(home) || path.startsWith(projectDir)).toBe(true);
    expect(Object.values(env).some((value) => value.includes(join(runDir, "oracle")))).toBe(false);
  });
});
