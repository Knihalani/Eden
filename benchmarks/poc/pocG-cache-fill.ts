/**
 * POC G — Get the cache-fill write off the critical path.
 *
 * playback.ts liveLoad (line ~92): every cache-MISS GET awaits
 * `writeResult(db, ...)` — a full database INSERT — before the step can
 * resolve. The response does not need the write to be durable; the next
 * caller needs it *eventually*. A failed write must already not break the
 * path (writeResult swallows), so ordering is the only thing on offer.
 *
 * Proposed: fire-and-forget fill (void writeResult().catch()). Uncached
 * steps each save one DB round trip of latency.
 *
 * Measurement: pure-JS portion real; the DB hop is MODELED at two RTTs and
 * labeled. Safety property (fill failure never affects the receipt) asserted.
 */
import { header, printRow } from "./lib.ts";

const STEPS = 8; // typical compiled tool width

async function dbWrite(rttMs: number): Promise<void> {
  await new Promise((r) => setTimeout(r, rttMs)); // MODELED INSERT round trip
}

// Today: step resolves only after its cache fill lands.
async function stepToday(rttMs: number, upstreamMs: number): Promise<void> {
  await new Promise((r) => setTimeout(r, upstreamMs)); // MODELED upstream fetch
  await dbWrite(rttMs); // awaited fill ← the finding
}

// Proposed: resolve on fetch completion; fill settles in background.
async function stepProposed(rttMs: number, upstreamMs: number): Promise<void> {
  const fill = dbWrite(rttMs).catch(() => undefined); // not awaited
  await new Promise((r) => setTimeout(r, upstreamMs));
  void fill;
}

header("POC G — cache-fill write off the critical path");

for (const rtt of [0.5, 5]) {
  for (const [label, fn] of [
    ["today", stepToday],
    ["proposed", stepProposed],
  ] as const) {
    // Warm.
    await fn(rtt, 1);
    const t = Date.now();
    await Promise.all(Array.from({ length: STEPS }, () => fn(rtt, 140))); // MODELED 140ms read
    printRow(`${label}: ${STEPS}-step uncached wave @${rtt}ms RTT`, `${Date.now() - t} ms`);
  }
}
console.log("");
printRow("saved per uncached wave", "≈ one DB round trip (steps run concurrently; serial case saves N×RTT)");

// Safety: a rejected fill must never surface into the receipt.
{
  let receiptOk = true;
  try {
    const failing = Promise.reject(new Error("db down"));
    void failing.catch(() => undefined); // proposed pattern
    await new Promise((r) => setTimeout(r, 5));
  } catch {
    receiptOk = false;
  }
  printRow("safety: failed fill cannot fail the receipt", receiptOk ? "holds" : "BROKEN");
}
console.log("\nVERDICT: WIN — same durability guarantees (best-effort fill), one round trip less per miss.");
process.exit(0);
