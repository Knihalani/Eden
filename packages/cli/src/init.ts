import { doctor } from "./doctor";
import { setup } from "./setup";
import { startHookdBackground } from "./hookd";

export const INIT_NEXT_STEPS = `
Next steps:
  1. Start wrap:                  eden wrap
  2. Point the agent at wrap:     OPENAI_BASE_URL=http://127.0.0.1:8788/v1
     Keep OPENAI_API_KEY as the model key. An Eden key is wrap auth, not OpenAI.
     Claude Code hooks are already installed by this command.
     Custom agent SDK:            POST /v1/wrap then POST /v1/ingest
                                  (miss → original; wrap down → original)

Inspect (offline — no wrap, no Approve):
  eden compile --traces examples/compile-traces/repeating
  Unique work (0 programs):       eden compile --traces examples/compile-traces/unique
  foreach / branch / poll / pages: examples/compile-traces/{foreach,branch,poll,cursor,offset}
  Compile does not Approve. It does not hit the network. It does not mint a wrap candidate.

Wrap verdict (does not ship):
  eden import --traces examples/compile-traces/repeating
  eden approve                    # FAIL / INCONCLUSIVE / pending until shadow certifies; cannot ship
  Toy traces will not PASS. Do not fake duration or tokens.

Play a compiled tool in one sitting:
  eden demo                       # TicketShip: compile, Approve in the demo, play T-100 (same as bun run demo)
  Then eden play against that wrap if it is still up. Quote the demo; do not fake metrics.

Your own agent (record through wrap):
  eden explain
  eden approve <id> --yes         # human gate — the only On switch
  eden play <name> --input '{...}'

LangSmith / OTel / JSONL exports:
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
`;

export function initHelp(): string {
  return `eden init — set up config, hooks, and MCP

  eden init              Write config, install hooks, start hookd, run doctor
  eden init --help       This letter; does not write config or install hooks

Does not start wrap. Does not Approve.
Then: eden wrap, or eden compile --traces examples/compile-traces/repeating
Play a compiled tool: eden demo (TicketShip T-100; same as bun run demo)
`;
}

export async function init(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(initHelp());
    return 0;
  }

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

  console.log(INIT_NEXT_STEPS);
  return 0;
}
