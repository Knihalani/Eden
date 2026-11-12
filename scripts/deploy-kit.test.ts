import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// deploy/scripts/bootstrap-dedicated.sh against stand-ins for ssh, ssh-keygen and ssh-keyscan: no machine is reached.
// The stand-in ssh records each call; it runs the deploy-key step locally (into a temp directory, through
// EDEN_SSH_DIR) and only records the cloud-init step, which would set up the machine it runs on.
const root = join(import.meta.dir, "..");
const script = join(root, "deploy/scripts/bootstrap-dedicated.sh");
const GITHUB_FP = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";
const URL = "git@github.com:Knihalani/Eden.git";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stage() {
  const dir = mkdtempSync(join(tmpdir(), "eden-bootstrap-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const log = join(dir, "log");
  const ssh = join(dir, "ssh");
  for (const d of [bin, log]) mkdirSync(d, { recursive: true });
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    "ssh",
    `n=$(ls "${log}" | wc -l); printf '%s\\n' "$2" > "${log}/$n.cmd"
if [[ "$2" == *eden_deploy* ]]; then EDEN_SSH_DIR="${ssh}" exec bash -c "$2"; fi
cat > "${log}/$n.stdin"`,
  );
  // A key holding the word PASSPHRASE stands for one that has a passphrase.
  stub(
    "ssh-keygen",
    `f="\${@: -1}"
if [ "$1" = -y ]; then if grep -q PASSPHRASE "$f"; then echo "incorrect passphrase supplied" >&2; exit 1; fi; exit 0; fi
if grep -q 'ssh-ed25519 GOOD' "$f"; then echo "256 ${GITHUB_FP} github.com (ED25519)"; else echo "256 SHA256:other x"; fi`,
  );
  stub("ssh-keyscan", `echo "github.com ssh-ed25519 \${KEYSCAN:-GOOD}"`);
  const key = join(dir, "eden_deploy");
  writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n");
  const run = (env: Record<string, string> = {}) => {
    const p = Bun.spawnSync(["bash", script, "root@203.0.113.10", "single", "main", URL, "198.51.100.7/32"], {
      // DEPLOY_KEY and KEYSCAN from the developer's own shell must not leak in (the quickstart exports DEPLOY_KEY).
      env: { ...process.env, DEPLOY_KEY: "", KEYSCAN: "", PATH: `${bin}:${process.env.PATH}`, ...env },
    });
    return { code: p.exitCode, stderr: p.stderr.toString() };
  };
  const calls = () =>
    readdirSync(log)
      .filter((f) => f.endsWith(".cmd"))
      .sort()
      .map((f) => readFileSync(join(log, f), "utf8"));
  return { dir, key, ssh, log, run, calls };
}

test("without DEPLOY_KEY: one SSH call, the cloud-init run, as before", () => {
  const s = stage();
  const r = s.run();
  expect(r.code).toBe(0);
  const calls = s.calls();
  expect(calls.length).toBe(1);
  expect(calls[0]).toContain("cloud-init init --local");
  expect(readFileSync(join(s.log, "0.stdin"), "utf8")).toContain(`git clone --depth 1 --branch main ${URL} /opt/eden`);
});

test("DEPLOY_KEY: the key, the github.com entry and the host key are installed before cloud-init runs", () => {
  const s = stage();
  mkdirSync(s.ssh, { recursive: true });
  writeFileSync(join(s.ssh, "config"), "Host other\n  User me\n");
  writeFileSync(join(s.ssh, "known_hosts"), "example.org ssh-ed25519 AAAA\ngithub.com ssh-rsa OLD\n");
  for (let i = 0; i < 2; i++) expect(s.run({ DEPLOY_KEY: s.key }).code).toBe(0);
  const calls = s.calls();
  expect(calls.length).toBe(4);
  expect(calls[0]).toContain("eden_deploy");
  expect(calls[1]).toContain("cloud-init init --local");
  // The key arrives over stdin, never in the command line.
  expect(calls[0]).not.toContain("fake");
  expect(readFileSync(join(s.ssh, "eden_deploy"), "utf8")).toBe(readFileSync(s.key, "utf8"));
  expect(statSync(join(s.ssh, "eden_deploy")).mode & 0o777).toBe(0o600);
  const config = readFileSync(join(s.ssh, "config"), "utf8");
  // First in the file, once after two runs, and the owner's own entries kept.
  expect(config.startsWith("# eden-deploy-key begin\nHost github.com\n")).toBe(true);
  expect(config).toContain(`  IdentityFile ${s.ssh}/eden_deploy\n  IdentitiesOnly yes\n`);
  expect(config.split("Host github.com").length).toBe(2);
  expect(config).toContain("Host other\n  User me\n");
  // The block is closed by "Host *", so whatever follows it is not read as part of the github.com entry.
  expect(config).toContain("  IdentitiesOnly yes\nHost *\n# eden-deploy-key end\n");
  expect(readFileSync(join(s.ssh, "known_hosts"), "utf8")).toBe(
    "example.org ssh-ed25519 AAAA\ngithub.com ssh-ed25519 GOOD\n",
  );
});

test("DEPLOY_KEY: a github.com host key other than GitHub's published one stops the run before cloud-init", () => {
  const s = stage();
  const r = s.run({ DEPLOY_KEY: s.key, KEYSCAN: "EVIL" });
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain(`expected ${GITHUB_FP}`);
  expect(r.stderr).toContain("nothing installed");
  expect(s.calls().length).toBe(1);
  // The host key is checked first: no key, no config entry, no known_hosts line, no temp file is left behind.
  expect(readdirSync(s.ssh)).toEqual([]);
});

test("DEPLOY_KEY: global options an existing config starts with still apply to every host", () => {
  const s = stage();
  mkdirSync(s.ssh, { recursive: true });
  writeFileSync(join(s.ssh, "config"), "ServerAliveInterval 30\nUser ops\n\nHost other\n  Port 2222\n");
  for (let i = 0; i < 2; i++) expect(s.run({ DEPLOY_KEY: s.key }).code).toBe(0);
  const config = readFileSync(join(s.ssh, "config"), "utf8");
  // ssh reads "Host *" as matching every host, so the owner's global options are global again after the block.
  const end = config.indexOf("Host *\n# eden-deploy-key end\n");
  expect(end).toBeGreaterThan(0);
  expect(config.indexOf("ServerAliveInterval 30")).toBeGreaterThan(end);
  expect(config.split("# eden-deploy-key begin").length).toBe(2);
});

test("DEPLOY_KEY: a missing key or one with a passphrase is refused before any SSH call", () => {
  const s = stage();
  expect(s.run({ DEPLOY_KEY: join(s.dir, "nope") }).code).toBe(2);
  writeFileSync(s.key, "PASSPHRASE\n");
  const r = s.run({ DEPLOY_KEY: s.key });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("without a passphrase");
  expect(r.stderr).toContain("incorrect passphrase supplied");
  expect(s.calls().length).toBe(0);
});

test("every deploy script parses (bash -n), and passes shellcheck at warning level where it is installed", () => {
  const dir = join(root, "deploy/scripts");
  const scripts = readdirSync(dir)
    .filter((f) => f.endsWith(".sh"))
    .map((f) => join(dir, f));
  expect(scripts.length).toBeGreaterThan(0);
  for (const f of scripts) {
    const p = Bun.spawnSync(["bash", "-n", f]);
    expect({ f, err: p.stderr.toString() }).toEqual({ f, err: "" });
  }
  if (!Bun.which("shellcheck")) return;
  const p = Bun.spawnSync(["shellcheck", "-S", "warning", ...scripts]);
  expect(p.stdout.toString()).toBe("");
});
