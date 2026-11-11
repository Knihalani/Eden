#!/usr/bin/env bun
/**
 * `bun run publish:check` (D853): builds every artifact Eden would publish and runs each registry's dry run, without
 * publishing anything. Publishing itself is the owner's decision (names, versions, licence, support).
 *
 * 1. `@eden/client` (npm): `pack:client` into `dist/publish/eden-client`, then `npm pack --dry-run` and
 *    `npm publish --dry-run` (no login needed; nothing is uploaded).
 * 2. `eden-client` (PyPI): `packages/client-python` staged with the repository's LICENSE into
 *    `dist/publish/client-python`, built to an sdist and a wheel with `python3 -m build`, checked with `twine check`.
 *    Needs `pip install build twine` (a venv's python: `PYTHON=/path/to/venv/bin/python`).
 * 3. The server image: `docker build`, a container started with a throwaway key, `/healthz` and `eden doctor` inside
 *    it, then removed. Behind a TLS-inspecting proxy set `EDEN_BUILD_CA` to its CA file (a build secret, not baked in).
 *
 * A step whose tool is missing (no python `build`, no Docker daemon) is reported as skipped and fails the run unless
 * `--allow-skip`. Prints one line per step and exits 1 on any failure.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { packClient } from "../packages/client/pack";

const root = resolve(import.meta.dir, "..");
const out = join(root, "dist", "publish");
const allowSkip = process.argv.includes("--allow-skip");
const python = process.env.PYTHON ?? "python3";

type Result = { step: string; status: "ok" | "failed" | "skipped"; detail: string };
const results: Result[] = [];

async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: `${o}\n${e}` };
}
const tail = (s: string) => s.trim().split("\n").slice(-3).join(" | ").slice(0, 400);

async function npmStep() {
  const dir = await packClient(join(out, "eden-client"));
  const packed = await run(["npm", "pack", "--dry-run", "--json"], dir);
  if (packed.code !== 0) return results.push({ step: "npm pack", status: "failed", detail: tail(packed.out) });
  const files = (
    JSON.parse(packed.out.slice(packed.out.indexOf("["), packed.out.lastIndexOf("]") + 1)) as {
      files: { path: string }[];
    }[]
  )[0]!.files.map((f) => f.path);
  for (const need of ["index.js", "package.json", "README.md", "LICENSE", "types/client/src/index.d.ts"]) {
    if (!files.includes(need)) return results.push({ step: "npm pack", status: "failed", detail: `missing ${need}` });
  }
  const pub = await run(["npm", "publish", "--dry-run"], dir);
  results.push({
    step: "npm publish --dry-run (@eden/client)",
    status: pub.code === 0 ? "ok" : "failed",
    detail: pub.code === 0 ? `${files.length} files` : tail(pub.out),
  });
}

async function pythonStep() {
  const has = await run([python, "-c", "import build, twine"], root);
  if (has.code !== 0) {
    return results.push({ step: "python build", status: "skipped", detail: `${python} lacks build/twine` });
  }
  const stage = join(out, "client-python");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const src = join(root, "packages", "client-python");
  for (const f of ["eden_client", "pyproject.toml", "README.md"])
    cpSync(join(src, f), join(stage, f), { recursive: true });
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  rmSync(join(stage, "eden_client", "__pycache__"), { recursive: true, force: true });
  const built = await run([python, "-m", "build", "-o", "dist", "."], stage);
  if (built.code !== 0) return results.push({ step: "python -m build", status: "failed", detail: tail(built.out) });
  const dists = readdirSync(join(stage, "dist")).map((f) => join(stage, "dist", f));
  const checked = await run([python, "-m", "twine", "check", "--strict", ...dists], stage);
  results.push({
    step: "twine check (eden-client sdist + wheel)",
    status: checked.code === 0 ? "ok" : "failed",
    detail: checked.code === 0 ? dists.map((d) => d.split("/").pop()).join(", ") : tail(checked.out),
  });
}

async function dockerStep() {
  const info = await run(["docker", "info", "--format", "{{.ServerVersion}}"], root);
  if (info.code !== 0) return results.push({ step: "docker build", status: "skipped", detail: "no Docker daemon" });
  const tag = "eden:publish-check";
  const ca = process.env.EDEN_BUILD_CA;
  const secret = ca && existsSync(ca) ? ["--secret", `id=ca,src=${ca}`] : [];
  const built = await run(["docker", "build", ...secret, "-t", tag, "."], root);
  if (built.code !== 0) return results.push({ step: "docker build", status: "failed", detail: tail(built.out) });
  const name = `eden-publish-check-${process.pid}`;
  const key = `k_check_${crypto.randomUUID().replaceAll("-", "")}`;
  const started = await run(
    ["docker", "run", "-d", "--name", name, "-e", `EDEN_API_KEYS=check:${key}`, "-e", "EDEN_PROCESSES=1", tag],
    root,
  );
  if (started.code !== 0) return results.push({ step: "docker run", status: "failed", detail: tail(started.out) });
  try {
    let healthy = false;
    for (let i = 0; i < 30 && !healthy; i++) {
      const h = await run(
        [
          "docker",
          "exec",
          name,
          "bun",
          "-e",
          "fetch('http://127.0.0.1:8790/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
        ],
        root,
      );
      healthy = h.code === 0;
      if (!healthy) await Bun.sleep(500);
    }
    if (!healthy) return results.push({ step: "docker run", status: "failed", detail: "no /healthz within 15 s" });
    const doctor = await run(
      ["docker", "exec", "-e", `EDEN_API_KEY=${key}`, name, "bun", "packages/server/src/cli.ts", "doctor"],
      root,
    );
    // Exit 1 is doctor's verdict on an empty tenant (nothing reported yet); only a crash is a failure here.
    const ran = doctor.code <= 1 && doctor.out.includes("to fix,");
    results.push({
      step: "docker image (healthz, eden doctor)",
      status: ran ? "ok" : "failed",
      detail: ran ? tag : tail(doctor.out),
    });
  } finally {
    await run(["docker", "rm", "-f", name], root);
  }
}

await npmStep().catch((e) => results.push({ step: "npm", status: "failed", detail: String(e).slice(0, 300) }));
await pythonStep().catch((e) => results.push({ step: "python", status: "failed", detail: String(e).slice(0, 300) }));
await dockerStep().catch((e) => results.push({ step: "docker", status: "failed", detail: String(e).slice(0, 300) }));
for (const r of results) console.log(`${r.status.padEnd(8)}${r.step}: ${r.detail}`);
const bad = results.filter((r) => r.status === "failed" || (r.status === "skipped" && !allowSkip));
process.exit(bad.length ? 1 : 0);
