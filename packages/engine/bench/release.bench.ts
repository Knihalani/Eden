/**
 * A rebalance at full size (D992): what it costs a node to release users to another machine, and the new owner to
 * fetch them, with users at the 3,000-item cap on prose. One `ItemCache` over a `SharedFrozenDisk` whose store is
 * in memory with a fixed latency per call (`--store-ms`, default 30: a PUT or GET of 1-3 MB to an object store in
 * the same region **[assumed]**); writes run 8 at a time, as in the server.
 *
 * The node holds USERS users in the peak-hour mix (a sixth live, the rest warm, docs/DEPLOY.md §6) and releases
 * them all (`ItemCache.release` + `handOff`, what `ContextPartner.releaseMoved` does for each moved user, without the
 * source-map export, which is a few hundred rows). Then a second cache (the new owner) reads each one back: the
 * awaited fetch in `ready`, then the thaw. Prints CPU per user, wall to release and settle, and fetch + thaw times.
 *
 *   bun packages/engine/bench/release.bench.ts [users=60] [itemsPerUser=3000] [--store-ms=30]
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextItem, Scope } from "@eden/protocol";
import { ItemCache } from "../src/cache";
import { type BlobStore, SharedFrozenDisk } from "../src/persist-shared";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const USERS = Number(args[0] ?? 60);
const PER_USER = Number(args[1] ?? 3_000);
const STORE_MS = Number(process.argv.find((a) => a.startsWith("--store-ms="))?.slice(11) ?? 30);
const KEY = new Uint8Array(32).map((_, i) => i * 7 + 3);

class SlowStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();
  bytes = 0;
  async put(key: string, bytes: Uint8Array): Promise<void> {
    await Bun.sleep(STORE_MS);
    this.objects.set(key, new Uint8Array(bytes));
    this.bytes += bytes.byteLength;
  }
  async get(key: string): Promise<Uint8Array | null> {
    await Bun.sleep(STORE_MS);
    return this.objects.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    await Bun.sleep(STORE_MS);
    this.objects.delete(key);
  }
  async *list(): AsyncIterable<{ key: string; modified: number }> {}
}

function prose(): string[] {
  const dir = new URL("../../../docs/", import.meta.url).pathname;
  const files = [...new Bun.Glob("**/*.md").scanSync(dir)].sort();
  const joined = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  return Array.from({ length: Math.floor(joined.length / 1_100) }, (_, i) => joined.slice(i * 1_100, (i + 1) * 1_100));
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10;
};

const pieces = prose();
const now = Date.now();
const dirs = [mkdtempSync(join(tmpdir(), "eden-release-a-")), mkdtempSync(join(tmpdir(), "eden-release-b-"))];
const store = new SlowStore();
const disk = (dir: string) =>
  new SharedFrozenDisk({ dir, key: KEY, maxBytes: 64 * 2 ** 30, maxAgeMs: 7 * 86_400_000, store, prefix: "f/" });
try {
  // Live users stay live; warm ones freeze warm (two-minute idle, D862): the cache's own ticks do it.
  const a = new ItemCache({ warmIdleMs: 120_000, expireEveryMs: 60_000, freezeIdleMs: 30 * 60_000 });
  a.close();
  const da = disk(dirs[0]!);
  a.persist(da);
  const users: Scope[] = Array.from({ length: USERS }, (_, u) => ({ tenantId: "bench", userId: `u${u}` }));
  const live = Math.max(1, Math.round(USERS / 6));
  const items = (u: number): ContextItem[] =>
    Array.from({ length: PER_USER }, (_, i) => ({
      id: `mail:u${u}-${i}`,
      sourceId: ["mail", "calendar", "docs"][i % 3]!,
      ref: `u${u}-${i}`,
      title: `Item ${i} for u${u}`,
      text: `${pieces[(u * 7 + i) % pieces.length]} u${u}`,
      updatedAt: now - i * 60_000,
      synced: true,
    }));
  // The warm users first, then a tick three minutes on so they freeze warm; the live ones after it, untouched.
  for (let u = live; u < USERS; u++) a.put(users[u]!, items(u), now);
  for (let t = 1; t <= 3; t++) a.expireIdle(now + t * 60_000);
  while (a.slicedPending > 0) a.expireIdle(now + 3 * 60_000);
  for (let u = 0; u < live; u++) a.put(users[u]!, items(u), now + 3 * 60_000);
  const warm = a.warmCount;

  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const per: number[] = [];
  for (const s of users) {
    const t = performance.now();
    if (!a.release(s)) throw new Error("not written");
    per.push(performance.now() - t);
  }
  const releasedMs = performance.now() - t0;
  await Promise.all(users.map((s) => da.handOff(s)));
  const settledMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);

  const b = new ItemCache();
  b.close();
  b.persist(disk(dirs[1]!));
  const fetchMs: number[] = [];
  const t1 = performance.now();
  await Promise.all(
    users.map(async (s) => {
      const t = performance.now();
      await b.ready(s);
      fetchMs.push(performance.now() - t);
    }),
  );
  const backMs = performance.now() - t1;
  if (b.userCount !== USERS) throw new Error(`read back ${b.userCount} of ${USERS}`);

  const out = {
    users: USERS,
    perUser: PER_USER,
    storeMs: STORE_MS,
    live,
    warm,
    blobMBPerUser: Math.round((store.bytes / USERS / 1_048_576) * 100) / 100,
    releaseMsPerUser: { p50: pct(per, 0.5), p99: pct(per, 0.99), liveP50: pct(per.slice(0, live), 0.5) },
    releaseCpuSec: Math.round(((cpu.user + cpu.system) / 1e6) * 100) / 100,
    releasedMs: Math.round(releasedMs),
    settledMs: Math.round(settledMs),
    readBack: { totalMs: Math.round(backMs), p50: pct(fetchMs, 0.5), p99: pct(fetchMs, 0.99) },
  };
  console.log(
    `${USERS} users x ${PER_USER} prose items (${live} live, ${warm} warm), store ${STORE_MS} ms a call:\n` +
      `release ${out.releasedMs} ms (${out.releaseMsPerUser.p50} ms a user p50, live ${out.releaseMsPerUser.liveP50}),` +
      ` in the store after ${out.settledMs} ms; blobs ${out.blobMBPerUser} MB a user\n` +
      `new owner: every user fetched and thawed in ${out.readBack.totalMs} ms (p50 ${out.readBack.p50}, p99 ${out.readBack.p99})`,
  );
  console.log(JSON.stringify(out));
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
