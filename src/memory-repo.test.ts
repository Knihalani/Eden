/**
 * D1's repo key against git itself: `hash(realpath(git rev-parse --path-format=absolute --git-common-dir))`, from a
 * checkout, its subdirectories and its linked worktrees; a submodule's own; outside git, the start directory's.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPlace, mainCheckout, repoIdentity, repoStoreDir } from "./memory-repo";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-repo-"));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

/** A repo with one commit, so worktrees and submodules can be added to it. */
function repo(dir: string): string {
  mkdirSync(join(dir, "packages", "cli"), { recursive: true });
  writeFileSync(join(dir, "packages", "cli", "index.ts"), "export {};\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  return dir;
}

/** The key D1 names, from git's own answer. */
function gitKey(cwd: string): string {
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return createHash("sha256").update(realpathSync(common)).digest("hex").slice(0, 16);
}

describe("repoIdentity (D1)", () => {
  test("a checkout, its subdirectory and its linked worktrees, inside it or not, share git's common-dir key", () => {
    const main = repo(join(temp(), "main"));
    const nested = join(main, ".claude", "worktrees", "agent-x");
    const outside = join(temp(), "elsewhere");
    git(main, "worktree", "add", "-q", "-b", "agent-x", nested);
    git(main, "worktree", "add", "-q", "-b", "outside", outside);
    const key = gitKey(main);
    for (const cwd of [main, join(main, "packages", "cli"), nested, join(nested, "packages", "cli"), outside]) {
      expect(gitKey(cwd)).toBe(key);
      expect(repoIdentity(cwd)?.key).toBe(key);
    }
    expect(repoIdentity(join(main, "packages", "cli"))?.top).toBe(main);
    expect(repoIdentity(nested)?.top).toBe(nested);
    // git writes the worktree's gitdir as a resolved path.
    expect(mainCheckout(gitPlace(outside)!)).toBe(realpathSync(main));
  });

  test("a symlinked path to the checkout has the same key", () => {
    const main = repo(join(temp(), "main"));
    const link = join(temp(), "link");
    symlinkSync(main, link);
    expect(repoIdentity(link)?.key).toBe(gitKey(main));
  });

  test("a submodule has its own store", () => {
    const lib = repo(join(temp(), "lib"));
    const app = repo(join(temp(), "app"));
    git(app, "submodule", "add", "-q", lib, "vendor/lib");
    const sub = join(app, "vendor", "lib");
    expect(repoIdentity(sub)?.key).toBe(gitKey(sub));
    expect(repoIdentity(sub)?.key).not.toBe(repoIdentity(app)?.key);
    expect(mainCheckout(gitPlace(sub)!)).toBe(sub);
  });

  test("outside git: the start directory's key, so a session keeps its store when it changes directory", () => {
    const home = temp();
    mkdirSync(join(home, "notes"));
    const key = createHash("sha256").update(realpathSync(home)).digest("hex").slice(0, 16);
    expect(repoIdentity(home)).toEqual({ key });
    expect(repoIdentity(join(home, "notes"), () => home)).toEqual({ key });
    expect(repoIdentity(join(home, "notes"))?.key).not.toBe(key);
  });

  test("a removed worktree inside a checkout still belongs to it; a relative or missing cwd has no identity", () => {
    const main = repo(join(temp(), "main"));
    expect(repoIdentity(join(main, ".claude", "worktrees", "gone"))?.key).toBe(gitKey(main));
    expect(repoIdentity("relative/path")).toBeUndefined();
    expect(repoIdentity(undefined)).toBeUndefined();
  });

  test("a repo's store is <root>/repos/<key>", () => {
    expect(repoStoreDir("/m", "0123456789abcdef")).toBe(join("/m", "repos", "0123456789abcdef"));
  });
});
