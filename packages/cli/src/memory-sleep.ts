/**
 * `eden sleep` (D34, A4 §6): a repo store's full sleep, off the hook path.
 *
 * - `--idle` is the detached sleeper that `stop-sleep` and SessionEnd start (`spawnIdleSleeper`). It waits until
 *   the repo's hooks have been quiet for `--after` seconds (default `EDEN_SLEEP_IDLE`, 5 minutes), then sleeps.
 *   Activity during the wait
 *   restarts it: D34 has the sleeper exit instead, but a pending sleeper is the only one its repo gets, so a repo
 *   whose last Stop came during the wait would stay unslept until its next session. It gives up after 6 hours.
 * - Activity is the mtime of the store's `activity` file, which every hook invocation touches (`noteRepoActivity`).
 * - One sleeper per store: a sleeper writes its pid to `sleep.pending` as it starts. A hook starts none while that
 *   process lives, and a sleeper that finds another pid there when it wakes exits, so two hooks racing to start one
 *   leave one.
 * - `EDEN_SLEEP_IDLE=off` (or 0) starts none: the tests and the harness, whose sessions never sit idle.
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "../../../src/index";
import { readableStore, repoIdentity, repoStoreDir } from "../../../src/memory-repo";
import { rebuildRecorded } from "../../../src/memory-scopes";
import { consolidate, sleepIdleMs } from "../../../src/sleep";
import { memoryConsent } from "../../../src/memory-consent";
import { memoryNow } from "../../../src/memory-clock";
import { proposeRecurring } from "../../../src/memory-user-global";
import { writeFileAtomic } from "./home";
import { memoryRoot } from "./memory-hook";

const ACTIVITY = "activity";
const PENDING = "sleep.pending";
/** A sleeper that has not found 5 quiet minutes in 6 hours leaves the store to the next one. */
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;

/** Marks the repo active: the idle sleeper waits for this to be 5 minutes old. */
export function noteRepoActivity(store: string): void {
  const path = join(store, ACTIVITY);
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    closeSync(openSync(path, "a", 0o600));
  }
}

function lastActivity(store: string): number {
  return statSync(join(store, ACTIVITY), { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

function pendingPid(store: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(join(store, PENDING), "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Starts the store's detached idle sleeper unless one is pending (see the header). */
export function spawnIdleSleeper(store: string, session: string | undefined): void {
  if (!(sleepIdleMs() > 0)) return;
  const pending = pendingPid(store);
  if (pending !== undefined && alive(pending)) return;
  // A compiled `eden` binary runs its own commands; a checkout runs the CLI's entry with bun.
  const script = join(import.meta.dir, "cli.ts");
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      ...(existsSync(script) ? [script] : []),
      "sleep",
      "--idle",
      "--store",
      store,
      ...(session ? ["--session", session] : []),
    ],
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: process.env,
  });
  child.unref();
}

/**
 * The full sleep over a repo store, as one session (the session's gist and how-tos), then D11's step over every
 * repo of the root: a rule pinned in 2 of them is proposed for all projects (`memory-user-global.ts`), and the
 * store's scope catalog is rebuilt from its checkout (D3).
 */
export function sleepStore(store: string, session: string | undefined): void {
  if (!existsSync(store) || !readableStore(store)) return;
  const mem = openMemory({ dir: store, session, perRepo: true });
  try {
    consolidate(mem, { session, mode: "full" });
  } finally {
    mem.close();
  }
  try {
    if (memoryConsent() === "on") proposeRecurring(memoryRoot(), memoryNow());
  } catch {}
  try {
    if (memoryConsent() === "on") rebuildRecorded(store);
  } catch {}
}

/** Waits until the store has been quiet for `afterMs` (see the header); false when the sleeper should not sleep. */
async function waitForIdle(store: string, afterMs: number): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (pendingPid(store) !== process.pid || !existsSync(store)) return false;
    const quiet = Date.now() - lastActivity(store);
    if (quiet >= afterMs) return true;
    await Bun.sleep(afterMs - quiet);
  }
  return false;
}

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/**
 * `eden sleep [--idle] [--after SECONDS] [--store DIR] [--session ID]`: sleeps over the store of `--store`,
 * else of the repo the command runs in. Exits 0 whatever happens: a failed sleep leaves the store as it was.
 */
export async function sleepCli(args: readonly string[]): Promise<number> {
  try {
    const cwdRepo = repoIdentity(process.cwd());
    const store = option(args, "--store") ?? (cwdRepo ? repoStoreDir(memoryRoot(), cwdRepo.key) : undefined);
    if (!store) return 0;
    const session = option(args, "--session");
    if (args.includes("--idle")) {
      const after = Number(option(args, "--after"));
      const afterMs = Number.isFinite(after) && after >= 0 ? after * 1000 : sleepIdleMs();
      if (!existsSync(store)) return 0;
      writeFileAtomic(join(store, PENDING), JSON.stringify({ pid: process.pid, t: Date.now() }), 0o600);
      try {
        if (await waitForIdle(store, afterMs)) sleepStore(store, session);
      } finally {
        if (pendingPid(store) === process.pid) rmSync(join(store, PENDING), { force: true });
      }
    } else sleepStore(store, session);
  } catch {}
  return 0;
}
