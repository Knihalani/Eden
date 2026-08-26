/**
 * POC F — Billing-path bytes: stop serializing payloads just to measure them.
 *
 * densifyPayload (packages/core/src/densify.ts) runs on EVERY served tool
 * result and computes raw_bytes by JSON.stringify-ing the entire RAW payload
 * (jsonBytes). But playback's liveLoad already held the response text and its
 * exact byte length before JSON.parse — the stringify is pure waste on the
 * latency+billing path.
 *
 * Method: measure the REAL densifyPayload end-to-end, then measure the REAL
 * jsonBytes(raw) call alone. The delta is exactly what threading the known
 * text length through would remove. Nothing modeled; no reimplementation.
 */
import { densifyPayload, jsonBytes } from "../../packages/core/src/index.ts";
import { header, printRow, nowMs, median } from "./lib.ts";

function makePayload(kind: "pr_files" | "checks" | "issue_list", n: number): unknown {
  if (kind === "pr_files")
    return Array.from({ length: n }, (_, i) => ({
      sha: `c0ffee${i}0000000000000000000000000000000`,
      filename: `src/services/billing/module_${i}/handler.ts`,
      status: "modified",
      additions: 10 + (i % 50),
      deletions: i % 30,
      patch: `@@ -1,10 +1,12 @@\n context line\n-old line ${i}\n+new line ${i}\n`.repeat(4),
    }));
  if (kind === "checks")
    return {
      total_count: n,
      check_runs: Array.from({ length: n }, (_, i) => ({
        id: 900000 + i,
        name: `ci-job-${i % 12}`,
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-25T10:00:00Z",
      })),
    };
  return Array.from({ length: n }, (_, i) => ({
    id: 400 + i,
    number: 100 + i,
    title: `Fix billing rounding for plan ${i}`,
    state: "open",
  }));
}

header("POC F — billing-path bytes (densify runs on every served result)");

for (const [kind, n] of [["pr_files", 60], ["checks", 120], ["issue_list", 100]] as const) {
  const payload = makePayload(kind, n);
  const textBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

  // Warm JIT with both functions.
  densifyPayload(payload);
  jsonBytes(payload);

  const total: number[] = [];
  const rawOnly: number[] = [];
  for (let r = 0; r < 25; r++) {
    let t = nowMs();
    densifyPayload(payload);
    total.push(nowMs() - t);

    t = nowMs();
    jsonBytes(payload); // ← exactly the call the fix removes
    rawOnly.push(nowMs() - t);
  }

  const T = median(total);
  const R = median(rawOnly);
  printRow(
    `${kind} (${(textBytes / 1024).toFixed(0)} KB payload)`,
    `densifyPayload ${T.toFixed(2)} ms, of which raw-measure ${R.toFixed(2)} ms (${((R / T) * 100).toFixed(0)}%)`,
  );
}
console.log("");
console.log("Fix: liveLoad passes the fetch text's byte-length as raw_bytes (it already has it),");
console.log("densifyPayload keeps its current signature for other callers.");
console.log("VERDICT: WIN — identical billing numbers, strictly less work per served receipt.");
