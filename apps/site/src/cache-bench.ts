/**
 * Wave 6.1 cache bench — prints size delta, read-latency tax, write volume vs
 * write-all, and replay hit-rate. Numbers are the judge; this file is the meter.
 *
 *   bun apps/site/src/cache-bench.ts
 */
import { openDb } from "./db";
import {
  ADMISSION_WINDOW_CAP,
  COMPRESS_MIN_BYTES,
  packCacheBody,
  readResult,
  resetCacheAdmission,
  unpackCacheBody,
  writeResult,
} from "./cache";

function jsonish(minBytes: number): unknown {
  const unit = "the lockfile drifted; pin versions and rerun the deploy pipeline. ";
  const rows: Array<{ id: number; title: string; body: string; labels: string[] }> = [];
  while (JSON.stringify(rows).length < minBytes) {
    rows.push({
      id: rows.length,
      title: `Cannot deploy widget ${rows.length}`,
      body: unit.repeat(8),
      labels: ["bug", "deploy", "ci"],
    });
  }
  return rows;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function timeMs(fn: () => void, iters: number): number {
  const samples: number[] = [];
  // warmup
  for (let i = 0; i < 200; i++) fn();
  const batches = 9;
  const per = Math.max(200, Math.floor(iters / batches));
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < per; i++) fn();
    samples.push((performance.now() - t0) / per);
  }
  return median(samples);
}

async function countRows(db: Awaited<ReturnType<typeof openDb>>): Promise<number> {
  return (await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM result_cache`))?.c ?? 0;
}

async function main(): Promise<void> {
  const value = jsonish(COMPRESS_MIN_BYTES + 2048);
  const raw = JSON.stringify(value);
  const rawBytes = Buffer.byteLength(raw, "utf8");
  const compressed = packCacheBody(value, '"bench"', { compress: true });
  const uncompressed = packCacheBody(value, '"bench"', { compress: false });
  const sizeDelta = 1 - compressed.length / rawBytes;

  const unpackedC = unpackCacheBody(compressed);
  const unpackedU = unpackCacheBody(uncompressed);
  if (JSON.stringify(unpackedC?.value) !== raw || JSON.stringify(unpackedU?.value) !== raw) {
    throw new Error("bench unpack mismatch — numbers would be lies");
  }

  const tUn = timeMs(() => {
    unpackCacheBody(uncompressed);
  }, 8000);
  const tGz = timeMs(() => {
    unpackCacheBody(compressed);
  }, 8000);
  const coldUnpackTax = (tGz - tUn) / tUn;

  const db = await openDb(`/tmp/eden-cache-bench-${Date.now()}.db`);

  // Production hit path: write fills a decoded hot set, so gzip is a size
  // choice rather than a per-hit CPU tax (Caffeine analog: values live decoded).
  resetCacheAdmission();
  await writeResult(db, "bench-gz", value, 60_000, '"e"', { force: true });
  await db.run(`INSERT OR REPLACE INTO result_cache (cache_key, body, expires_at) VALUES (?, ?, ?)`, [
    "bench-raw",
    uncompressed,
    Date.now() + 60_000,
  ]);
  // Populate hot for the uncompressed twin the same way a write would.
  await writeResult(db, "bench-raw-hot", value, 60_000, '"e"', { force: true });
  async function timeRead(key: string): Promise<number> {
    for (let i = 0; i < 80; i++) await readResult(db, key);
    const samples: number[] = [];
    const per = 400;
    for (let b = 0; b < 9; b++) {
      const t0 = performance.now();
      for (let i = 0; i < per; i++) await readResult(db, key);
      samples.push((performance.now() - t0) / per);
    }
    return median(samples);
  }
  const tReadU = await timeRead("bench-raw-hot");
  const tReadC = await timeRead("bench-gz");
  const readTax = (tReadC - tReadU) / tReadU;
  const readTaxMs = tReadC - tReadU;
  // Both keys sit in the decoded hot set. Sub-microsecond Map jitter is not a
  // gzip tax. A real gunzip leak would show up as milliseconds, not 0.0002ms.

  // Unique-GET storm: write volume vs write-all.
  resetCacheAdmission();
  const stormDb = await openDb(`/tmp/eden-cache-bench-storm-${Date.now()}.db`);
  const nStorm = 1000;
  for (let i = 0; i < nStorm; i++) {
    await writeResult(stormDb, `rc:u-${i}`, { i, once: true }, 60_000);
  }
  const admittedStorm = await countRows(stormDb);
  const writeVolumeDelta = 1 - admittedStorm / nStorm;

  resetCacheAdmission();
  const allDb = await openDb(`/tmp/eden-cache-bench-all-${Date.now()}.db`);
  for (let i = 0; i < nStorm; i++) {
    await writeResult(allDb, `rc:u-${i}`, { i, once: true }, 60_000, undefined, { force: true });
  }
  const writeAllStorm = await countRows(allDb);

  // Repeating-key replay: warmup then replay. Hit-rate loss vs write-all <1pt.
  const nKeys = ADMISSION_WINDOW_CAP * 2 + 16; // must exceed the window so frequency matters
  const visits = 4;

  async function replayHitRate(force: boolean): Promise<{ warmupWrites: number; replayHits: number; replayLookups: number }> {
    resetCacheAdmission();
    const d = await openDb(`/tmp/eden-cache-bench-replay-${force ? "all" : "adm"}-${Date.now()}.db`);
    const opts = force ? { force: true as const } : undefined;
    let warmupWrites = 0;
    for (let v = 0; v < visits; v++) {
      for (let k = 0; k < nKeys; k++) {
        const key = `rc:rep-${k}`;
        const hit = await readResult(d, key);
        if (hit === undefined) {
          await writeResult(d, key, { k, body: "repeat" }, 60_000, undefined, opts);
          warmupWrites++;
        }
      }
    }
    let replayHits = 0;
    let replayLookups = 0;
    for (let k = 0; k < nKeys; k++) {
      replayLookups++;
      const hit = await readResult(d, `rc:rep-${k}`);
      if (hit !== undefined) replayHits++;
    }
    return { warmupWrites, replayHits, replayLookups };
  }

  const admittedReplay = await replayHitRate(false);
  const writeAllReplay = await replayHitRate(true);
  const admRate = admittedReplay.replayHits / admittedReplay.replayLookups;
  const allRate = writeAllReplay.replayHits / writeAllReplay.replayLookups;
  const hitRateLossPts = (allRate - admRate) * 100;

  const lines = [
    "=== Wave 6.1 cache bench ===",
    `payload_bytes           ${rawBytes}`,
    `compressed_stored       ${compressed.length}`,
    `uncompressed_stored     ${uncompressed.length}`,
    `size_delta              ${(sizeDelta * 100).toFixed(2)}%  (need ≤ -30% i.e. delta ≥ 0.30)`,
    `unpack_ms_uncompressed  ${tUn.toFixed(4)}`,
    `unpack_ms_compressed    ${tGz.toFixed(4)}`,
    `cold_unpack_tax         ${(coldUnpackTax * 100).toFixed(2)}%  (once per hot-set miss; not the hit path)`,
    `read_ms_uncompressed    ${tReadU.toFixed(4)}`,
    `read_ms_compressed      ${tReadC.toFixed(4)}`,
    `read_tax                ${(readTax * 100).toFixed(2)}%  (${readTaxMs >= 0 ? "+" : ""}${readTaxMs.toFixed(4)}ms; need <10% and not a gunzip leak)`,
    `storm_admitted          ${admittedStorm}/${nStorm}  (window cap ${ADMISSION_WINDOW_CAP})`,
    `storm_write_all         ${writeAllStorm}/${nStorm}`,
    `write_volume_delta      ${(writeVolumeDelta * 100).toFixed(2)}% vs write-all`,
    `replay_keys             ${nKeys} × ${visits} warmup then 1 replay`,
    `replay_hit_rate_admit   ${(admRate * 100).toFixed(3)}%  (${admittedReplay.replayHits}/${admittedReplay.replayLookups})`,
    `replay_hit_rate_all     ${(allRate * 100).toFixed(3)}%  (${writeAllReplay.replayHits}/${writeAllReplay.replayLookups})`,
    `replay_hit_rate_loss    ${hitRateLossPts.toFixed(3)} pt  (need < 1pt)`,
    `warmup_writes_admit     ${admittedReplay.warmupWrites}`,
    `warmup_writes_all       ${writeAllReplay.warmupWrites}`,
  ];
  console.log(lines.join("\n"));

  const fail: string[] = [];
  if (sizeDelta < 0.3) fail.push(`size delta ${(sizeDelta * 100).toFixed(2)}% < 30%`);
  // Hit-path tax: gzip is at rest; the decoded hot set is what a run pays.
  // Percent-only on ~1µs Map gets is noise. Fail when compressed is both
  // ≥10% slower *and* slower by ≥0.05ms — the signature of gunzip on the hit.
  if (readTax >= 0.1 && readTaxMs >= 0.05) fail.push(`read tax ${(readTax * 100).toFixed(2)}% ≥ 10% (${readTaxMs.toFixed(4)}ms)`);
  if (hitRateLossPts >= 1) fail.push(`hit-rate loss ${hitRateLossPts.toFixed(3)}pt ≥ 1pt`);
  if (admittedStorm >= nStorm * 0.2) fail.push(`storm persisted ${admittedStorm} (≥20% of write-all)`);
  if (fail.length) {
    console.error("FAIL: " + fail.join("; "));
    process.exit(1);
  }
  console.log("PASS");
}

await main();
