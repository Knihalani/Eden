#!/usr/bin/env bash
# Builds the BEFORE tree of docs/research/final-before-after.md: the product packages of 18366d039 (PR #198, the
# engine before the 2026-11-02..04 campaign), unchanged, with this repo's lab (packages/sim, packages/llm, the eval
# and two engine benches) from LAB_REV laid over them, and a lab-only shim for the names the old engine lacks.
#
#   packages/sim/lab/before-after/make-before-tree.sh DIR [LAB_REV]    # LAB_REV default: origin/main
#
# Afterwards `git -C DIR diff 18366d039 -- packages/{engine,graph,sources,primitives,redact,protocol,client}` is
# empty: only lab code differs from 18366d039. Run the lab from DIR with `--config default` (the old built-in
# DEFAULT_CONFIG) or `--config ALL3` / `--variant-config '{"A":<ALL3>}'` (the old presets.ts, verbatim).
set -euo pipefail
DIR=${1:?usage: make-before-tree.sh DIR [LAB_REV]}
LAB=${2:-origin/main}
BEFORE=18366d039
HERE=$(cd "$(dirname "$0")" && pwd)
git worktree add --detach "$DIR" "$BEFORE"
cd "$DIR"
git checkout "$LAB" -- packages/sim packages/llm packages/eval package.json bun.lock \
  packages/engine/bench/ingest.bench.ts packages/engine/bench/workload.ts
bun install

cat > packages/sim/src/before-engine.ts <<'EOF'
/**
 * BEFORE-tree shim (docs/research/final-before-after.md): main's lab (bf2fc13) runs here against the engine of
 * 18366d039, unchanged. The lab imports a few names that engine did not have yet; they are stubbed here so the lab
 * links. None of them is reached by the configurations measured (the old DEFAULT_CONFIG and the old ALL3 have no
 * askReader and no parts).
 */
import { DEFAULT_CONFIG } from "@eden/engine";
export * from "@eden/engine";

const absent = (name: string) => () => {
  throw new Error(`${name}: not in the 18366d039 engine (BEFORE tree)`);
};
export class AskReader {
  constructor() {
    absent("AskReader")();
  }
}
export class ModelReaderMaker {
  constructor() {
    absent("ModelReaderMaker")();
  }
}
// hidden-funnel.ts hashes the reader's system prompt when it loads; with no reader wired an empty prompt stands in.
export const readerMessages = (_input: unknown): { role: string; content: string }[] => [];
export const readerKey = absent("readerKey");
export const readerItem = absent("readerItem");
export type Part = string;
export const PARTS: Record<string, Record<string, unknown>> = {};
export const CORE_CONFIG = DEFAULT_CONFIG;
export type ReaderReport = any;
export type ReaderInput = any;
export type ReaderMaker = any;
export type ReaderKind = any;
/** Main's checkEngineConfig, reduced to the key check: an unknown key (a typo, or a later engine's) exits. */
export function checkEngineConfig(value: unknown, options: { where?: string } = {}): Record<string, unknown> {
  const where = options.where ?? "engine config";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!(key in DEFAULT_CONFIG)) throw new Error(`${where}: unknown key "${key}" for the 18366d039 engine`);
  }
  return value as Record<string, unknown>;
}
EOF

# Every lab and eval import of @eden/engine goes through the shim (tests are not run in this tree).
for f in $(grep -rl 'from "@eden/engine"' packages/sim/src packages/eval/src --include=*.ts | grep -v '\.test\.ts' |
  grep -v before-engine.ts); do
  rel=$(realpath --relative-to="$(dirname "$f")" packages/sim/src/before-engine.ts)
  rel=${rel%.ts}
  [[ $rel != .* ]] && rel=./$rel
  sed -i "s#from \"@eden/engine\"#from \"$rel\"#" "$f"
done

# The old presets (H, ALL3, ALL5) verbatim, plus `default` = {} and the `effective` the lab reads.
{
  printf '/** BEFORE tree: the lab presets of %s verbatim, plus `default` and `effective`. */\n' "$BEFORE"
  printf 'import { DEFAULT_CONFIG, type EngineConfig } from "../before-engine";\n\n'
  git show "$BEFORE":packages/sim/src/lab/presets.ts | sed -n '/^export const PRESETS/,$p' |
    sed 's/^export const PRESETS: Record<string, Record<string, unknown>> = {$/&\n  default: {},/'
  printf '\nexport function effective(override: Record<string, unknown>): EngineConfig {\n'
  printf '  return { ...DEFAULT_CONFIG, ...override } as EngineConfig;\n}\n'
} > packages/sim/src/lab/presets.ts

# ingest.bench.ts against the old sync (ingest-patch.py says what changes and why).
python3 -I "$HERE/ingest-patch.py"

git diff --stat "$BEFORE" -- packages/engine/src packages/graph packages/sources packages/primitives packages/redact \
  packages/protocol packages/client | tail -1
echo "BEFORE tree ready at $DIR (an empty diff line above means the product packages are 18366d039's)"
