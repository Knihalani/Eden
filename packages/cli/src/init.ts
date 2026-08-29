import { doctor } from "./doctor";
import { setup } from "./setup";
import { startHookdBackground } from "./hookd";

/**
 * eden init: one command that goes from zero to running.
 *
 * Calls setup (config + hooks + MCP), starts the recording daemon when it is
 * down, then runs doctor. Does NOT start `eden wrap` — that stays the other
 * process. Stop the daemon with `eden hookd --stop`.
 */
export async function init(args: string[]): Promise<void> {
  console.log("eden init: setting up…\n");
  try {
    await setup(args);
    console.log("✓ config written, hooks installed, MCP configured\n");
  } catch (err) {
    // If auth fails but we're in dev mode, continue — local wrap doesn't need a key.
    const isDev = process.env.EDEN_DEV === "1" || args.includes("--dev");
    if (!isDev) throw err;
    console.log("⚠ auth skipped (dev mode)\n");
  }

  if (await startHookdBackground()) {
    console.log("Recording daemon starting (`eden hookd`). Stop with `eden hookd --stop`.\n");
  }

  console.log("Running health check…\n");
  const code = await doctor([]);
  if (code !== 0) {
    console.log("\n⚠ Some checks failed. Run `eden doctor` for details.");
  }

  console.log(`
Next steps:
  1. Start the control plane:   eden wrap
  2. Point your agent at:       OPENAI_BASE_URL=http://127.0.0.1:8788/v1
  3. Or use Claude Code hooks (already installed by this command)
  4. Run your agent — Eden records tool calls automatically
  5. After a few runs:          eden explain
  6. Approve a candidate:       eden approve <id> --yes
     (or visit http://127.0.0.1:8788 — same human gate)

Import existing traces:
  eden import --file langsmith-export.jsonl

Safety model (the prime directive — a broken Eden never breaks your agent):
  • Default is observe: Eden records and steers where provably safe, but never
    blocks, halts, or refuses one of your agent's calls.
  • Compiled runs that fail fall back to your tool's normal execution — unless
    the workflow already performed a write, in which case you get a structured
    error instead of a duplicated side effect.
  • Hard guardrails (runaway-loop caps, spend ceilings) are opt-in:
      EDEN_ENFORCE=1     guards may halt thrash and refuse unverifiable writes
      EDEN_STEER_HOOKS=1 hooks may point Claude Code at the compiled MCP tool
    Neither is set by this command. Turn them on when you trust the setup.
`);
}
