// `bun run build:local` — compile eden-local standalone binaries (A1).
//
// Builds `packages/server/src/main.ts` with `bun build --compile` into `dist/local/`
// for the current platform; `--all` cross-compiles the release matrix (the same
// targets `scripts/hermes-local/install.py` ships: x64 gets the baseline build so
// pre-AVX2 CPUs start). `--target=bun-<os>-<arch>[-baseline]` builds one.
// Then `bun run verify:local` smoke-tests the native binary.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist", "local");

const ALL: [target: string, name: string][] = [
  ["bun-linux-x64-baseline", "eden-local-linux-x64"],
  ["bun-linux-arm64", "eden-local-linux-arm64"],
  ["bun-darwin-x64", "eden-local-darwin-x64"],
  ["bun-darwin-arm64", "eden-local-darwin-arm64"],
  ["bun-windows-x64-baseline", "eden-local-windows-x64.exe"],
  ["bun-windows-arm64", "eden-local-windows-arm64.exe"],
];

const osName = process.platform === "win32" ? "windows" : process.platform;
const nativeSuffix = `-${osName}-${process.arch}`;

const args = new Set(process.argv.slice(2));
const one = [...args].find((a) => a.startsWith("--target="))?.split("=")[1];
const jobs: [string, string][] = args.has("--all")
  ? ALL
  : one
    ? ALL.filter(([t]) => t === one)
    : ALL.filter(([, n]) => n.includes(nativeSuffix));
if (jobs.length === 0 && !one) throw new Error(`no build:local job for ${process.platform}-${process.arch}`);
if (one && jobs.length === 0)
  throw new Error(`unknown --target=${one} (want one of ${ALL.map(([t]) => t).join(", ")})`);

mkdirSync(out, { recursive: true });
for (const [target, name] of jobs) {
  const output = join(out, name);
  console.log(`building ${output} (${target})…`);
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--target",
      target,
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "packages/server/src/main.ts",
      "--outfile",
      output,
    ],
    { cwd: root, stdout: "inherit", stderr: "pipe" },
  );
  const code = await build.exited;
  if (code !== 0) {
    console.error(await new Response(build.stderr).text());
    throw new Error(`build --compile failed for ${target} (${code})`);
  }
}
console.log(`done: ${out}`);
