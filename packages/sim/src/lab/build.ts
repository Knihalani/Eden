#!/usr/bin/env bun
/**
 * Builds the lab's images: each open-source MCP server from its repository at the pinned commit in
 * packages/sim/lab/servers.json, plus backends with no official image. Third-party code is only installed and built
 * here, inside `docker build`; it runs later in containers with no secrets and no network but the lab's own.
 *
 *   bun packages/sim/src/lab/build.ts [name...]
 *
 * Builds go through HTTPS_PROXY when set, trusting LAB_CA_FILE (default: the cloud session's proxy CA, if present).
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAB = join(import.meta.dir, "../../lab");
const servers = JSON.parse(readFileSync(join(LAB, "servers.json"), "utf8")) as Record<
  string,
  { repo?: string; commit?: string }
>;

const run = (cmd: string[], cwd?: string) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (${p.exitCode})`);
};

export function buildImage(name: string): void {
  const spec = servers[name];
  if (!spec) throw new Error(`no lab server ${name}`);
  const ctx = mkdtempSync(join(tmpdir(), `lab-${name}-`));
  try {
    cpSync(join(LAB, name), ctx, { recursive: true });
    const ca = process.env.LAB_CA_FILE ?? "/root/.ccr/ca-bundle.crt";
    writeFileSync(join(ctx, "ca.crt"), existsSync(ca) ? readFileSync(ca) : "");
    if (spec.repo && spec.commit) {
      const src = join(ctx, "src");
      run(["git", "init", "-q", src]);
      run(["git", "-C", src, "fetch", "-q", "--depth", "1", spec.repo, spec.commit]);
      run(["git", "-C", src, "checkout", "-q", "FETCH_HEAD"]);
      rmSync(join(src, ".git"), { recursive: true, force: true });
    }
    const proxy = process.env.HTTPS_PROXY ?? "";
    run([
      "docker",
      "build",
      "-q",
      "--network",
      "host",
      "--build-arg",
      `HTTPS_PROXY=${proxy}`,
      "-t",
      `lab/${name}`,
      ctx,
    ]);
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const names = process.argv.slice(2);
  for (const name of names.length ? names : Object.keys(servers)) {
    console.log(`building lab/${name}`);
    buildImage(name);
  }
}
