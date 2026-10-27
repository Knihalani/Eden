/**
 * gate-know-sota: wraps `bun .gauntlet/know-sota.ts <tmp.json>` (read-only wrt ~/.eden;
 * it only stat()s ~/.eden/know files) and prints:
 *   sota_holdout_hits: N   (query_path.holdout "15/15" -> 15, or holdout_known)
 *   sota_p50_ns: N         (query_path.eden_query_p50_ns)
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/kaiavnihalani/Downloads/Eden";
const SCRATCH = "/private/tmp/claude-501/-Users-kaiavnihalani-Downloads-Eden/e33660fb-cfbd-4686-a261-fbbcefbe3776/scratchpad";
mkdirSync(SCRATCH, { recursive: true });
const out = join(SCRATCH, `gate-know-sota-${process.pid}.json`);

const r = Bun.spawnSync(["bun", ".gauntlet/know-sota.ts", out], { cwd: ROOT, stdout: "ignore", stderr: "pipe" });
if (r.exitCode !== 0 || !existsSync(out)) {
  process.stderr.write(`know-sota failed (exit ${r.exitCode})\n${r.stderr.toString().slice(-2000)}`);
  process.exit(1);
}
const j = JSON.parse(readFileSync(out, "utf8")) as { query_path?: Record<string, unknown> };
const qp = j.query_path || {};
const hs = String(qp.holdout ?? "");
const hits = /^(\d+)\s*\//.test(hs) ? Number(hs.match(/^(\d+)/)![1]) : Number(qp.holdout_known ?? 0);
const p50 = Number(qp.eden_query_p50_ns ?? 0);
try {
  rmSync(out, { force: true });
} catch {}
console.log(`sota_holdout_hits: ${Math.round(hits)}`);
console.log(`sota_p50_ns: ${Math.round(p50)}`);
