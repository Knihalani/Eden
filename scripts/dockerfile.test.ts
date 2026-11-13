import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The image copies files one by one, so a file every `bun` needs at startup can be left out with nothing failing until
// the container starts: bunfig.toml's preload (scripts/lab-guard.ts, D818) once stopped the server on every boot with
// `preload not found` (D990). Building the image is too slow for the test run; this checks the paths instead.
const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

/** Each COPY's sources, as repo-relative paths ("packages", "scripts/lab-guard.ts"). */
function copied(dockerfile: string): string[] {
  const out: string[] = [];
  for (const line of dockerfile.split("\n")) {
    const m = /^COPY\s+(?:--\S+\s+)*(.+)$/.exec(line.trim());
    if (!m) continue;
    const parts = m[1]!.trim().split(/\s+/);
    for (const src of parts.slice(0, -1)) out.push(src.replace(/^\.\//, "").replace(/\/$/, ""));
  }
  return out;
}

const inImage = (path: string, sources: string[]) =>
  sources.some((s) => path === s || path.startsWith(`${s}/`) || s === ".");

test("every file bunfig.toml preloads outside tests, and the CMD's entry, is copied into the image", () => {
  const sources = copied(read("Dockerfile"));
  expect(sources).toContain("bunfig.toml");
  // The top-level table only: [test]'s preload runs under `bun test`, which the image never runs.
  const top = read("bunfig.toml").split(/^\[/m)[0]!;
  const preload = /^preload\s*=\s*\[([^\]]*)\]/m.exec(top);
  const preloads = preload ? [...preload[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.replace(/^\.\//, "")) : [];
  const cmd = /^CMD\s+\[(.+)\]/m.exec(read("Dockerfile"));
  const entry = cmd ? [...cmd[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).find((a) => a.endsWith(".ts")) : undefined;
  expect(entry).toBeDefined();
  for (const path of [...preloads, entry!])
    expect({ path, copied: inImage(path, sources) }).toEqual({ path, copied: true });
});

test("the COPY parser sees a single file, a directory and flags", () => {
  expect(copied("COPY a.json b.toml ./\nCOPY --chown=bun:bun packages ./packages\nRUN x")).toEqual([
    "a.json",
    "b.toml",
    "packages",
  ]);
  expect(inImage("scripts/lab-guard.ts", ["packages"])).toBe(false);
  expect(inImage("packages/server/src/main.ts", ["packages"])).toBe(true);
});

// D1700: .dockerignore leaves the lab, tests and benches out of the image. A server importing one of them would start
// only to fail on a missing module, so the servers' static imports are walked from their entry points (relative paths
// and @eden/* packages; a package's own dependencies are not followed) and none may land on an excluded path.
const ENTRIES = [
  "packages/server/src/main.ts",
  "packages/server/src/cli.ts",
  "packages/server/src/mcp-stdio.ts",
  "packages/server/src/doctor.ts",
  "packages/server/src/digest.ts",
  "packages/server/src/trace-report.ts",
  "packages/proxy/src/main.ts",
];
/** The secret gate's test support (D1705): re2js, its oracle, is a devDependency, so it is not installed there. */
const GATE_TEST_SUPPORT = ["packages/redact/src/re2-oracle.ts", "packages/redact/src/differential.ts"];
const excludedFromImage = (path: string) =>
  (path.startsWith("packages/sim/") && path !== "packages/sim/package.json") ||
  path.endsWith(".test.ts") ||
  /^packages\/[^/]+\/bench\//.test(path) ||
  GATE_TEST_SUPPORT.includes(path);

/** Bare module names (not relative, `@eden/*`, `node:` or `bun:`) the served files import: npm packages. */
const npmImports = new Set<string>();

function served(): Set<string> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const queue = [...ENTRIES];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    // A shebang line (cli.ts) is not TypeScript to the scanner.
    for (const { path: spec } of transpiler.scanImports(read(file).replace(/^#!.*/, ""))) {
      let target: string | undefined;
      if (!/^(\.|@eden\/|node:|bun:|bun$)/.test(spec)) npmImports.add(spec);
      if (spec.startsWith(".")) target = join(file, "..", spec);
      else if (spec.startsWith("@eden/")) {
        const [, name, ...rest] = spec.split("/");
        const pkg = JSON.parse(read(`packages/${name}/package.json`)) as { exports?: Record<string, string> };
        const sub = rest.length === 0 ? "." : `./${rest.join("/")}`;
        target = join(`packages/${name}`, pkg.exports?.[sub] ?? `${sub}.ts`);
      }
      if (target === undefined) continue;
      // Imports name a file without its extension, a .ts file, or a directory's index.
      const found = [target, `${target}.ts`, join(target, "index.ts")].find(
        (f) => f.endsWith(".ts") && existsSync(join(root, f)),
      );
      if (found !== undefined) queue.push(found);
    }
  }
  return seen;
}

test("the .dockerignore excludes what the servers never import", () => {
  const ignore = read(".dockerignore");
  for (const line of [
    "packages/sim/**",
    "!packages/sim/package.json",
    "**/*.test.ts",
    "packages/*/bench",
    ...GATE_TEST_SUPPORT,
  ])
    expect(ignore.split("\n")).toContain(line);
  const files = served();
  expect(files.size).toBeGreaterThan(50);
  expect(files.has("packages/engine/src/index.ts")).toBe(true);
  expect([...files].filter(excludedFromImage)).toEqual([]);
  // The walk would see an import of the lab: it reaches @eden/sim's entry from a file that imports it.
  expect(excludedFromImage("packages/sim/src/index.ts")).toBe(true);
});

// D1705: Eden ships with no production npm dependency (`bun install --production` installs none). The servers import
// no npm package; the secret gate's oracle, re2js, is a devDependency its tests alone load.
test("the servers import no npm package", () => {
  served();
  expect([...npmImports]).toEqual([]);
});

// D1600: the server runs on Bun's distroless image, which has no /bin/sh. A shell-form RUN, CMD or HEALTHCHECK in the
// final stage fails only when the container starts (or turns unhealthy), so the final stage is checked here. It runs
// as uid 1000, the full image's `bun` user, so a volume an earlier image wrote stays writable.
test("the final stage is distroless, runs as uid 1000, and needs no shell", () => {
  const stages = read("Dockerfile").split(/^FROM\s+/m);
  const last = stages[stages.length - 1]!;
  expect(last.split("\n")[0]).toMatch(/^oven\/bun:[\d.]+-distroless\b/);
  // The build stage installs with the same Bun version that serves.
  const versions = stages.slice(1).map((s) => /^oven\/bun:([\d.]+)/.exec(s)?.[1]);
  expect(new Set(versions).size).toBe(1);
  // Instructions, joined across continuation lines.
  const instructions = last.replace(/\\\n\s*/g, " ").split("\n");
  expect(instructions.filter((l) => /^RUN\s/.test(l))).toEqual([]);
  for (const l of instructions.filter((l) => /^(CMD|ENTRYPOINT)\s/.test(l))) expect(l).toMatch(/^\w+\s+\[/);
  expect(instructions.find((l) => l.startsWith("HEALTHCHECK"))).toMatch(/\sCMD\s+\[/);
  expect(instructions.find((l) => l.startsWith("USER"))).toBe("USER 1000:1000");
});
