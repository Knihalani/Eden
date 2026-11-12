/**
 * A preload for every `bun` started from the repository (bunfig.toml): a lab script refuses to start while
 * `OPENROUTER_API_KEY` is set, unless `EDEN_ALLOW_OPENROUTER=1` (the owner's rule of 2026-11-11: paid lab calls go to
 * the Anthropic API only). The lab's harnesses build Eden's model roles from the environment, so a key left in a
 * shell sent their calls to OpenRouter (P5 saw it happen). Only scripts under packages/sim/ are refused: the servers
 * and the eval's no-model run are product paths, and tests clear `OPENROUTER_*` themselves (scripts/test-preload.ts).
 * `bun run eval --live` is the shipped wiring on OpenRouter by design and is not a lab script.
 */
export function refusal(entry: string, env: Record<string, string | undefined>): string | null {
  if (!/[\\/]packages[\\/]sim[\\/]/.test(entry)) return null;
  if (!env.OPENROUTER_API_KEY || env.EDEN_ALLOW_OPENROUTER === "1") return null;
  return (
    "lab scripts do not run with OPENROUTER_API_KEY set (paid lab calls go to the Anthropic API only): " +
    "unset it (`unset OPENROUTER_API_KEY`, or `env -u OPENROUTER_API_KEY bun …`), or set EDEN_ALLOW_OPENROUTER=1 " +
    "for a run the owner has approved"
  );
}

const why = refusal(process.argv[1] ?? "", process.env);
if (why) {
  console.error(why);
  process.exit(2);
}

// The queue transport (F9, D1101): with EDEN_LAB_QUEUE set, every lab script answers Anthropic Messages API calls
// through the queue's files, including the scripts that build their own `AnthropicModel` without `labAccess`.
const entry = process.argv[1] ?? "";
if (process.env.EDEN_LAB_QUEUE && /[\\/]packages[\\/]sim[\\/]/.test(entry) && !/[\\/]subagent[\\/]/.test(entry)) {
  const { installQueue } = await import("../packages/sim/src/lab/queue-transport");
  installQueue(process.env.EDEN_LAB_QUEUE);
}
