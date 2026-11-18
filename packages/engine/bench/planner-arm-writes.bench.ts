/**
 * Planner arm writes (saveArms) on a file-backed SourceMap: what QueryPlanner.search credits per connector search
 * (one shape arm, and a cascade arm when the cascade ran), as the server's planner does with `store: sourceMap`.
 *
 *   env -u BUN_OPTIONS bun packages/engine/bench/planner-arm-writes.bench.ts [lookups=2000] [connectors=4] [users=20]
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";

const lookups = Number(process.argv[2] ?? 2_000);
const connectors = Number(process.argv[3] ?? 4);
const users = Number(process.argv[4] ?? 20);
const written = () => Number(/write_bytes: (\d+)/.exec(readFileSync("/proc/self/io", "utf8"))![1]);
const dir = mkdtempSync(join(tmpdir(), "eden-arm-writes-"));
const map = new SourceMap(join(dir, "map.db"));
const shapes = ["terms", "entities", "each-entity", "phrase"];
let calls = 0;
let ms = 0;
let state = 1;
const rand = () => (state = (state * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32;
const before = written();
const t0 = performance.now();
for (let i = 0; i < lookups; i++) {
  const scope = { tenantId: "acme", userId: `u${i % users}` };
  for (let c = 0; c < connectors; c++) {
    const sourceId = `src${c}`;
    const bucket = rand() < 0.5 ? 0 : 1;
    const s = performance.now();
    map.saveArms(scope, sourceId, [
      { bucket, shape: shapes[Math.floor(rand() * shapes.length)]!, alpha: 1 + i / 10, beta: 1 + rand() },
    ]);
    calls++;
    if (rand() < 0.5) {
      map.saveArms(scope, sourceId, [{ bucket, shape: "cascade", alpha: 1 + i / 20, beta: 1 + rand() }]);
      calls++;
    }
    ms += performance.now() - s;
  }
}
const loopMs = performance.now() - t0;
map.close();
const bytes = written() - before;
console.log(
  JSON.stringify({
    lookups,
    connectors,
    users,
    saveArmsCalls: calls,
    usPerSaveArms: +((ms * 1_000) / calls).toFixed(2),
    loopMs: +loopMs.toFixed(1),
    writeBytes: bytes,
    bytesPerCall: +(bytes / calls).toFixed(1),
  }),
);
rmSync(dir, { recursive: true, force: true });
