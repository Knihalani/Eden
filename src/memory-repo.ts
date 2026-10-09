/**
 * Repo identity (D1, A4 §1): every long-term store is one repo's, keyed by its common git dir, so the sessions,
 * worktrees and subagents of a repo share one memory and two repos never do.
 *
 * - The key is `hash(realpath(git rev-parse --path-format=absolute --git-common-dir))`. It is read from the files git
 *   itself reads, with no git process: a `.git` directory is the common dir; a `.git` file names a git dir, whose
 *   `commondir` file (a linked worktree's) names the common dir, and without one (a submodule's) the git dir is it.
 *   So every linked worktree shares its main checkout's key, and a submodule has its own.
 * - `top` is the path's own worktree root (`--show-toplevel`): the directory holding that `.git`.
 * - With no git, the key is `hash(realpath(cwd at SessionStart))` (`startCwd`), and there is no top.
 *
 * D1 caches `dir → (repo, top)` in `<root>/dirmap.json` because the git call costs 20–40 ms (R5 §7). This walk is a
 * few `stat` calls, under a millisecond, so there is no call to cache and no cached mapping to go stale.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Where a path sits in git: its worktree root and the repo's common git dir, both as found (not resolved). */
export interface GitPlace {
  top: string;
  common: string;
}

export interface RepoIdentity {
  /** 16 hex characters of the hash (A4 §4's `repo8` is the first 8). */
  key: string;
  /** The worktree root of a git path; none without git (scope is then always `""`, D1). */
  top?: string;
}

/** The git dir a `.git` file names (`gitdir: <path>`), resolved from the file's directory. */
function gitdirOf(dotGit: string): string | undefined {
  const named = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
  return named ? resolve(dirname(dotGit), named) : undefined;
}

/** A git dir's common dir: what its `commondir` file names (a linked worktree's), else the git dir itself. */
function commonDirOf(gitdir: string): string {
  try {
    const named = readFileSync(join(gitdir, "commondir"), "utf8").trim();
    return named ? resolve(gitdir, named) : gitdir;
  } catch {
    return gitdir;
  }
}

/**
 * The git place of an absolute path: the nearest ancestor holding `.git`. A path that no longer exists is placed by
 * its nearest existing ancestor, so a removed worktree inside a checkout still belongs to that checkout's repo.
 */
export function gitPlace(path: string | undefined): GitPlace | undefined {
  if (!path || !isAbsolute(path)) return undefined;
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    try {
      if (statSync(dotGit).isDirectory()) return { top: dir, common: dotGit };
      const gitdir = gitdirOf(dotGit);
      if (gitdir) return { top: dir, common: commonDirOf(gitdir) };
    } catch {}
    if (dirname(dir) === dir) return undefined;
  }
}

/** The checkout whose `.git` directory is the common dir: every worktree's main checkout; a submodule is its own. */
export function mainCheckout(place: GitPlace): string {
  return /[\\/]\.git$/.test(place.common) ? dirname(place.common) : place.top;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function repoKeyOf(path: string): string {
  return createHash("sha256").update(realpathOrSelf(path)).digest("hex").slice(0, 16);
}

/**
 * The repo a hook event's `cwd` belongs to (D1). Outside git, the session's SessionStart `cwd` names it when one was
 * recorded (`startCwd`, read only then), so a session that changes directory keeps its store. Undefined without an
 * absolute `cwd`.
 */
export function repoIdentity(cwd: string | undefined, startCwd?: () => string | undefined): RepoIdentity | undefined {
  const place = gitPlace(cwd);
  if (place) return { key: repoKeyOf(place.common), top: place.top };
  if (!cwd || !isAbsolute(cwd)) return undefined;
  const start = startCwd?.();
  return { key: repoKeyOf(start && isAbsolute(start) ? start : cwd) };
}

/** A repo's store directory under the memory root (A4 §1 `<root>/repos/<repo>/`). */
export function repoStoreDir(root: string, key: string): string {
  return join(root, "repos", key);
}

/** The store format this code writes and reads (EXECUTION §9: every store carries `format.json`). */
export const STORE_FORMAT = 2;

/** Whether a store is in a format this code reads: a reader never injects from an unknown major version. */
export function readableStore(dir: string): boolean {
  try {
    const major = (JSON.parse(readFileSync(join(dir, "format.json"), "utf8")) as { major?: unknown }).major;
    return typeof major !== "number" || major <= STORE_FORMAT;
  } catch {
    return true;
  }
}

/** Gives a store its `format.json` when it has none. */
export function markStoreFormat(dir: string): void {
  const path = join(dir, "format.json");
  if (!existsSync(path)) writeFileSync(path, `${JSON.stringify({ major: STORE_FORMAT })}\n`, { mode: 0o600 });
}

/** Where `eden memory migrate` keeps the tree it replaced (`memory-migrate.ts`). */
export function legacyTree(root: string): string {
  return `${resolve(root)}.legacy-v1`;
}

/** Where `eden memory migrate` builds the new tree before the swap. */
export function migrationStage(root: string): string {
  return `${resolve(root)}.migrate-stage`;
}

/** Whether a migration is between its two renames: no root, its new tree still staged. A hook then writes nothing. */
export function swapping(root: string): boolean {
  return !existsSync(root) && existsSync(migrationStage(root));
}
