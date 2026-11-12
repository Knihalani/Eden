import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

// D1310: the server runs on Bun's distroless image, which has no /bin/sh. A shell-form RUN, CMD or HEALTHCHECK in the
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
