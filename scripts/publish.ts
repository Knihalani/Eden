#!/usr/bin/env bun
/**
 * `bun run publish -- --yes` — publish the Eden SDKs (A9):
 *
 *   @eden/client → npm (`npm publish --access public`, needs NPM_TOKEN in the environment)
 *   eden-client  → PyPI (`twine upload`, needs PYPI_TOKEN; pip's `build`+`twine` packages required)
 *
 * Secrets are never printed or written into the repository: NPM_TOKEN goes only into a `.npmrc`
 * inside the staged package under dist/, PYPI_TOKEN only into twine's environment. Without `--yes`
 * the script prints the plan and exits — publishing is a deliberate act (docs/RELEASE.md).
 * `--npm` / `--pypi` publish one side only.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packClient } from "../packages/client/pack";

const root = resolve(import.meta.dir, "..");
const out = join(root, "dist", "publish");
const FLAGS = new Set(["--yes", "--npm", "--pypi"]);
const args = process.argv.slice(2);
const bad = args.filter((a) => !FLAGS.has(a));
// The raw values are not echoed: an argument may itself be a credential typed in the wrong place.
if (bad.length > 0) throw new Error(`${bad.length} unknown flag(s) (allowed: --yes, --npm, --pypi)`);
const yes = args.includes("--yes");
const doNpm = !args.includes("--pypi") || args.includes("--npm");
const doPy = !args.includes("--npm") || args.includes("--pypi");
const python = process.env.PYTHON ?? "python3";

async function run(cmd: string[], cwd: string, env?: Record<string, string>): Promise<number> {
  const p = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
  return p.exited;
}

function versionOf(dir: string): string {
  const v = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version as string;
  if (!v || v === "0.0.0") throw new Error(`@eden/client version is "${v}" — bump it first (docs/RELEASE.md)`);
  return v;
}

async function npmPublish(version: string) {
  const dir = join(out, "eden-client");
  if (!yes) return console.log(`npm: would publish @eden/client@${version} --access public`);
  if (!process.env.NPM_TOKEN) throw new Error("NPM_TOKEN is not set (org secrets → environment)");
  writeFileSync(join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n");
  const code = await run(["npm", "publish", "--access", "public"], dir, { NPM_CONFIG_USERCONFIG: join(dir, ".npmrc") });
  // npm expands ${NPM_TOKEN} from its own env only via the project .npmrc we staged;
  // delete it so the credential file never outlives the publish.
  rmSync(join(dir, ".npmrc"));
  if (code !== 0) throw new Error(`npm publish failed (${code})`);
  console.log(`npm: published @eden/client@${version}`);
}

function pypiVersion(): string {
  const src = join(root, "packages", "client-python", "pyproject.toml");
  const version = readFileSync(src, "utf8").match(/^version = "([^"]+)"/m)?.[1];
  if (!version || version === "0.0.0") throw new Error(`eden-client version is "${version}" — bump it first`);
  return version;
}

async function pypiPublish(version: string) {
  const token = process.env.PYPI_TOKEN;
  if (!token) {
    if (yes) throw new Error("PYPI_TOKEN is not set (org secrets → environment)");
  }
  const has = await run([python, "-c", "import build, twine"], root);
  if (has !== 0) throw new Error(`${python} lacks build/twine (pip install build twine)`);
  const stage = join(out, "client-python");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const src = join(root, "packages", "client-python");
  for (const f of ["eden_client", "pyproject.toml", "README.md"])
    cpSync(join(src, f), join(stage, f), { recursive: true });
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  rmSync(join(stage, "eden_client", "__pycache__"), { recursive: true, force: true });
  if (!yes) {
    console.log(`pypi: would publish eden-client@${version}` + (token ? "" : " (PYPI_TOKEN needed at publish time)"));
    return;
  }
  if ((await run([python, "-m", "build", "-o", "dist", "."], stage)) !== 0) throw new Error("python -m build failed");
  const dists = readdirSync(join(stage, "dist")).map((f) => join(stage, "dist", f));
  const code = await run([python, "-m", "twine", "upload", "--non-interactive", ...dists], stage, {
    TWINE_USERNAME: "__token__",
    TWINE_PASSWORD: token!,
  });
  if (code !== 0) throw new Error(`twine upload failed (${code})`);
  console.log(`pypi: published eden-client@${version}`);
}

// Every selected side validates before anything publishes: an npm upload that precedes a PyPI version
// rejection leaves the rerun unable to retry the combined release (the npm version already exists).
const npmVersion = doNpm ? versionOf(await packClient(join(out, "eden-client"))) : null;
const pyVersion = doPy ? pypiVersion() : null;
console.log(yes ? "publishing…" : "dry run — pass --yes to publish for real");
if (npmVersion) await npmPublish(npmVersion);
if (pyVersion) await pypiPublish(pyVersion);
