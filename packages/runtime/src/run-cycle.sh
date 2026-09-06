#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
LOOP="${1:?loop number}"
NOTE="${2:-}"
TEST_OUT="$(mktemp)"
BENCH_OUT="$(mktemp)"
set +e
bun test packages/ir/src/ir.test.ts packages/runtime packages/compile/src/compile.test.ts packages/shadow/src/shadow.test.ts packages/wrap packages/cli/src/hook.test.ts packages/cli/src/login.test.ts apps/control/src/golden.test.ts >"$TEST_OUT" 2>&1
TEST_EC=$?
bun run packages/runtime/src/bench.ts >"$BENCH_OUT" 2>&1
BENCH_EC=$?
set -e
echo "----- tests (loop $LOOP) -----"
tail -n 8 "$TEST_OUT"
echo "----- bench (loop $LOOP) -----"
cat "$BENCH_OUT"
LOOP="$LOOP" NOTE="$NOTE" TEST_EC="$TEST_EC" BENCH_EC="$BENCH_EC" TEST_OUT="$TEST_OUT" BENCH_OUT="$BENCH_OUT" bun -e '
const fs = require("fs");
const test = fs.readFileSync(process.env.TEST_OUT, "utf8");
const benchRaw = fs.readFileSync(process.env.BENCH_OUT, "utf8");
const pass = Number((test.match(/(\d+) pass/) || [])[1] || 0);
const fail = Number((test.match(/(\d+) fail/) || [])[1] || 0);
let bench = {};
try { bench = JSON.parse(benchRaw.replace(/^[\s\S]*?(\{)/, "$1")); } catch {}
const row = {
  loop: Number(process.env.LOOP),
  note: process.env.NOTE,
  test_ec: Number(process.env.TEST_EC),
  bench_ec: Number(process.env.BENCH_EC),
  pass, fail,
  gates: bench.gates ?? null,
  reduction: bench.reduction ?? null,
  compiler: bench.compiler ?? null,
};
fs.appendFileSync("packages/runtime/loop-results.jsonl", JSON.stringify(row) + "\n");
console.log("logged", row);
if (row.test_ec !== 0 || row.bench_ec !== 0 || fail > 0) process.exit(1);
if (!row.gates?.llm5x || !row.gates?.ms5x || !row.gates?.cents5x || !row.gates?.verifyPinned) process.exit(2);
'
