/**
 * `eden sleep` (D34, A4 §6): a repo store's full sleep, off the hook path.
 *
 * - `--idle` is the detached sleeper that `stop-sleep` and SessionEnd start (`spawnIdleSleeper`). It waits until
 *   the repo's hooks have been quiet for `--after` seconds (default `EDEN_SLEEP_IDLE`, 5 minutes), then sleeps.
 *   Activity during the wait
 *   restarts it: D34 has the sleeper exit instead, but a pending sleeper is the only one its repo gets, so a repo
 *   whose last Stop came during the wait would stay unslept until its next session. It gives up after 6 hours.
 * - **The heavy tier** (D34: the same process at ≥ 30 quiet minutes, `EDEN_SLEEP_HEAVY`) then mines the repo's
 *   files (D8, `memory-citations.ts`). The sleeper waits on for it, sleeping again whenever the repo was active
 *   meanwhile; `--after 0`, a caller that has seen the idle time itself (the harness), waits for neither and runs
 *   each tier the store's quiet time already allows. `--heavy` is SessionStart's detached launch: it mines at once,
 *   whether or not an idle sleeper is pending (it has its own marker, `mine.pending`; the citation lock serialises
 *   two minings).
 * - Activity is the mtime of the store's `activity` file, which every hook invocation touches (`noteRepoActivity`),
 *   set to the memory clock (`EDEN_NOW` in the harness, so its skipped minutes count as quiet).
 * - One sleeper per store: a sleeper writes its pid to `sleep.pending` as it starts. A hook starts none while that
 *   process lives, and a sleeper that finds another pid there when it wakes exits, so two hooks racing to start one
 *   leave one.
 * - `EDEN_SLEEP_IDLE=off` (or 0) starts none: the tests and the harness, whose sessions never sit idle.
 * - Run in a repo with no store yet (no `--store`), `eden sleep` gives it one, with its scope catalog, so the first
 *   session's cues meet the repo's facts.
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "../../../src/index";
import { applyMined } from "../../../src/memory-citations";
import { readFolders } from "../../../src/memory-repo-facts";
import { markStoreFormat, readableStore, repoIdentity, repoStoreDir } from "../../../src/memory-repo";
import { buildCatalog, readCatalog, rebuildRecorded, recordedCheckout } from "../../../src/memory-scopes";
import { consolidate, sleepIdleMs } from "../../../src/sleep";
import { memoryConsent } from "../../../src/memory-consent";
import { memoryNow } from "../../../src/memory-clock";
import { proposeRecurring } from "../../../src/memory-user-global";
import { writeFileAtomic } from "./home";
import { memoryRoot } from "./memory-hook";

const ACTIVITY = "activity";
const PENDING = "sleep.pending";
/** The heavy launch's own marker: one mining per store at a time, beside a pending idle sleeper. */
const MINE_PENDING = "mine.pending";
/** A sleeper that has not found 5 quiet minutes in 6 hours leaves the store to the next one. */
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
/** D34: the heavy tier runs after this long without activity. */
const HEAVY_IDLE_MS = 30 * 60_000;

/**
 * The heavy tier's quiet time: `EDEN_SLEEP_HEAVY` in ms, 30 minutes by default; `off` (or 0) runs it only on demand
 * (`--heavy`, or `eden sleep` with no tier).
 */
export function sleepHeavyMs(raw = process.env.EDEN_SLEEP_HEAVY): number {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (["0", "off", "false", "none"].includes(value)) return 0;
  return /^\d+$/.test(value) ? Number(value) : HEAVY_IDLE_MS;
}

/** Marks the repo active: the idle sleeper waits for this to be 5 minutes old. */
export function noteRepoActivity(store: string): void {
  const path = join(store, ACTIVITY);
  const now = new Date(memoryNow());
  try {
    utimesSync(path, now, now);
  } catch {
    closeSync(openSync(path, "a", 0o600));
    utimesSync(path, now, now);
  }
}

function lastActivity(store: string): number {
  return statSync(join(store, ACTIVITY), { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

/** How long the store's hooks have been quiet, by the memory clock. */
function quietMs(store: string): number {
  return memoryNow() - lastActivity(store);
}

function pendingPid(store: string, marker = PENDING): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(join(store, marker), "utf8")) as { pid?: unknown }).pid;
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
  spawnSleeper(store, ["--idle", ...(session ? ["--session", session] : [])], PENDING);
}

/** D34: SessionStart's detached heavy sleep, which mines the repo's files at once (see the header). */
export function spawnHeavySleeper(store: string): void {
  spawnSleeper(store, ["--heavy"], MINE_PENDING);
}

/**
 * Starts a detached `eden sleep` over the store unless one with the same marker is pending; none while
 * `EDEN_SLEEP_IDLE` is off.
 */
function spawnSleeper(store: string, args: readonly string[], marker: string): void {
  if (!(sleepIdleMs() > 0)) return;
  const pending = pendingPid(store, marker);
  if (pending !== undefined && alive(pending)) return;
  // A compiled `eden` binary runs its own commands; a checkout runs the CLI's entry with bun.
  const script = join(import.meta.dir, "cli.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, ...(existsSync(script) ? [script] : []), "sleep", "--store", store, ...args],
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

/**
 * D34's heavy tier, as far as it is built: D8's repo-fact mining over the checkout the store's catalog was built
 * from, every folder of the catalog (`memory-citations.ts`).
 */
export function mineStore(store: string): void {
  const checkout = recordedCheckout(store);
  const catalog = readCatalog(store);
  if (checkout === undefined || !catalog || memoryConsent() !== "on") return;
  const mem = openMemory({ dir: store, perRepo: true });
  try {
    applyMined(mem, readFolders(checkout, catalog.scopes));
  } finally {
    mem.close();
  }
}

/** Waits until the store has been quiet for `afterMs` (see the header); false when the sleeper should not sleep. */
async function waitForIdle(store: string, afterMs: number, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (pendingPid(store) !== process.pid || !existsSync(store)) return false;
    const quiet = quietMs(store);
    if (quiet >= afterMs) return true;
    await Bun.sleep(afterMs - quiet);
  }
  return false;
}

/**
 * The idle sleeper (see the header): sleeps after `afterMs` of quiet, again after each later burst of activity, and
 * mines once the store has been quiet for `sleepHeavyMs`; with `afterMs` 0 it does at once what the quiet allows.
 */
async function sleepWhenIdle(store: string, session: string | undefined, afterMs: number): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  const heavyMs = sleepHeavyMs();
  let slept: number | undefined;
  while (await waitForIdle(store, afterMs, deadline)) {
    if (lastActivity(store) !== slept) {
      slept = lastActivity(store);
      sleepStore(store, session);
    }
    if (heavyMs > 0 && quietMs(store) >= heavyMs) return mineStore(store);
    if (afterMs === 0 || heavyMs === 0) return;
    await Bun.sleep(Math.min(heavyMs - quietMs(store), Math.max(0, deadline - Date.now())));
  }
}

/** A repo's store, given one with its catalog when it has none (see the header); undefined outside a repo. */
function storeOfRepo(cwd: string): string | undefined {
  const repo = repoIdentity(cwd);
  if (!repo) return undefined;
  const store = repoStoreDir(memoryRoot(), repo.key);
  if (!existsSync(store) && repo.top && memoryConsent() === "on") {
    buildCatalog(store, repo.top);
    markStoreFormat(store);
  }
  return store;
}

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/**
 * `eden sleep [--idle [--after SECONDS] | --heavy] [--store DIR] [--session ID]`: sleeps over the store of `--store`,
 * else of the repo the command runs in. Without a tier, the full sleep and the heavy tier at once. Exits 0 whatever
 * happens: a failed sleep leaves the store as it was.
 */
export async function sleepCli(args: readonly string[]): Promise<number> {
  try {
    const store = option(args, "--store") ?? storeOfRepo(process.cwd());
    if (!store || !existsSync(store) || !readableStore(store)) return 0;
    const session = option(args, "--session");
    if (args.includes("--idle") || args.includes("--heavy")) {
      const heavy = args.includes("--heavy");
      const marker = heavy ? MINE_PENDING : PENDING;
      const after = Number(option(args, "--after"));
      const afterMs = Number.isFinite(after) && after >= 0 ? after * 1000 : sleepIdleMs();
      writeFileAtomic(join(store, marker), JSON.stringify({ pid: process.pid, t: Date.now() }), 0o600);
      try {
        if (heavy) mineStore(store);
        else await sleepWhenIdle(store, session, afterMs);
      } finally {
        if (pendingPid(store, marker) === process.pid) rmSync(join(store, marker), { force: true });
      }
    } else {
      sleepStore(store, session);
      mineStore(store);
    }
  } catch {}
  return 0;
}
