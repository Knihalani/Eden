#!/usr/bin/env bun
export function edenHelp(): string {
  return `usage: eden [--help] <command> [<args>]

Eden is passive memory for coding agents. It remembers what you told the
agent and what it learned about the repo, and injects the matching note on a
later turn. Hooks fail open. No model runs on the hook path.

memory
   setup       Write the hooks for Claude Code, Gemini CLI, Codex, OpenCode
               (they also run the retired tool recorder; the plugin does not)
   doctor      Check that everything is healthy (--memory: memory only)
   memory      Remember, dump, scopes, forget, purge, import, migrate (eden memory --help)
   sleep       Consolidate this repo's store and mine its files now
   eval        Build your private real-negative set (eval build-negatives)
   hook        The hook entry point (called by hooks)
   hookd       Start the daemon the setup hooks call (they fall back to hook)
   wrap        Start the local proxy (127.0.0.1:8788): memory for OpenAI-compatible agents

start a working area
   init        setup, then start hookd, run doctor and print the compile-era guide

compile traces into a tool (retired: archived/compile-era)
   compile     Compile traces into a program letter (--traces <dir>). Local only
   import      Send traces to wrap (--traces dir, or --file LangSmith/OTel). Does not Approve
   explain     Why nothing compiled (exact counts)
   approve     Print the card; --yes ships canary (human gate)
   play        Run an approved tool (--input '{...}') — needs Approve PASS
   demo        TicketShip sitting (T-100; same as bun run demo)
   drain       Flush pending tool recordings
   claims      Published limits board (wins, analogue, limits, retired)
   savings     Show cumulative savings
   bench       Benchmark compiled tools (--traces <dir>)
   login       Save a hosted key (eden login --url … --key …)
   mcp         Stdio MCP in front of wrap (empty catalog; dispatch ≤1)

'eden help' and 'eden --help' print this screen. See 'eden help -a'
for advanced commands. Commands that run on any arguments, --help
included: setup, sleep, hook, hookd, drain, login, status, savings,
open, reject, fulfill, prefetch, recall, runner, manifest, mcp-headers.
`;
}

export function edenHelpAdvanced(): string {
  return `usage: eden [--help] <command> [<args>]

advanced
   login       Authenticate with a hosted Eden instance
   status      Show current configuration
   mcp         Stdio MCP in front of wrap (empty catalog; --help is a letter)
   promote     Promote a canary tool to Live (100%)
   schedule    Operator cron for a live tool (does not Approve)
   open        Open the first-stretch card
   reject      Decline the first-stretch knock
   fulfill     Batch fulfillment from a plan file
   recall      Recall previously prefetched results
   audit export      Write approvals, versions, executions, refusals (JSONL or CSV)
   audit review      Who approved what, when, which version (tenant-bound)
   audit verify      Check a hash-chained export; fails closed on tamper
   archive status    Counts per hot/warm/cold tier
   archive compact   Move eligible runs hot → warm → cold
   digest      Weekly letter that mirrors Home (opt-in; EDEN_DIGEST=1)
   doctor --tree  Wave 16–20 leftover letter (Wave 21 closed; Wave 22 Later)
   know run    Continuous web ingest onto the Know graph (free, robots-ok)
`;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "login") {
    const { login } = await import("./login");
    await login(rest);
  } else if (cmd === "status") {
    const { status } = await import("./login");
    await status();
  } else if (cmd === "wrap") {
    const { wrapCmd } = await import("./wrap-cmd");
    await wrapCmd(rest);
  } else if (cmd === "hook") {
    const hookdP = import("./hookd").then((m) => m.startHookdBackground());
    const { runHook } = await import("./hook");
    await runHook(rest[0]);
    await hookdP;
  } else if (cmd === "mcp") {
    const { runMcp } = await import("./mcp");
    await runMcp(rest);
  } else if (cmd === "setup") {
    const { setup } = await import("./setup");
    await setup(rest);
  } else if (cmd === "init") {
    const { init } = await import("./init");
    process.exit(await init(rest));
  } else if (cmd === "import") {
    const { importTraces } = await import("./import");
    process.exit(await importTraces(rest));
  } else if (cmd === "sleep") {
    const { sleepCli } = await import("./memory-sleep");
    process.exit(await sleepCli(rest));
  } else if (cmd === "memory") {
    const { memoryCli } = await import("./memory-import");
    process.exit(await memoryCli(rest));
  } else if (cmd === "runner") {
    const { runner } = await import("./runner");
    await runner(rest);
  } else if (cmd === "drain") {
    const { drain } = await import("./drain");
    await drain();
  } else if (cmd === "hookd") {
    const { runHookd } = await import("./hookd");
    await runHookd(rest);
  } else if (cmd === "play") {
    const { playCli } = await import("./play");
    process.exit(await playCli(rest));
  } else if (cmd === "demo") {
    const { demoCli } = await import("./demo");
    process.exit(await demoCli(rest));
  } else if (cmd === "manifest") {
    const { manifestCli } = await import("./manifest");
    manifestCli(rest);
  } else if (cmd === "open") {
    const { openTool } = await import("./open");
    await openTool();
  } else if (cmd === "reject") {
    const { rejectTool } = await import("./open");
    process.exit(await rejectTool());
  } else if (cmd === "fulfill") {
    const { fulfillCli } = await import("./play");
    await fulfillCli(rest);
  } else if (cmd === "prefetch") {
    const { prefetchCli } = await import("./play");
    await prefetchCli(rest);
  } else if (cmd === "recall") {
    const { recallCli } = await import("./play");
    await recallCli(rest);
  } else if (cmd === "mcp-headers") {
    const { mcpHeaders } = await import("./headers");
    mcpHeaders();
  } else if (cmd === "doctor") {
    const { doctor } = await import("./doctor");
    process.exit(await doctor(rest));
  } else if (cmd === "eval") {
    const { evalCli } = await import("./eval-negatives");
    process.exit(await evalCli(rest));
  } else if (cmd === "savings") {
    const { savings } = await import("./login");
    await savings();
  } else if (cmd === "bench") {
    const { bench } = await import("./bench");
    process.exit(await bench(rest));
  } else if (cmd === "compile") {
    const { compileCli } = await import("./compile");
    process.exit(await compileCli(rest));
  } else if (cmd === "audit") {
    const { auditCli } = await import("./audit");
    process.exit(await auditCli(rest));
  } else if (cmd === "archive") {
    const { archiveCli } = await import("./archive");
    process.exit(await archiveCli(rest));
  } else if (cmd === "digest") {
    const { digestCli } = await import("./digest");
    process.exit(await digestCli(rest));
  } else if (cmd === "explain") {
    const { explainCli } = await import("./explain");
    process.exit(await explainCli(rest));
  } else if (cmd === "claims") {
    const { claimsCli } = await import("./claims");
    process.exit(await claimsCli(rest));
  } else if (cmd === "approve") {
    const { approveCli } = await import("./approve");
    process.exit(await approveCli(rest));
  } else if (cmd === "promote") {
    const { promoteCli } = await import("./approve");
    process.exit(await promoteCli(rest));
  } else if (cmd === "schedule") {
    const { scheduleCli } = await import("./schedule");
    process.exit(await scheduleCli(rest));
  } else if (cmd === "know") {
    const { knowCli } = await import("@eden/know");
    process.exit(await knowCli(rest));
  } else if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    const all = rest.includes("-a") || rest.includes("--all") || (cmd === "help" && rest[0] === "-a");
    console.log(all ? edenHelpAdvanced() : edenHelp());
    process.exit(0);
  } else {
    console.error(`eden: '${cmd}' is not an eden command. See 'eden --help'.`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
