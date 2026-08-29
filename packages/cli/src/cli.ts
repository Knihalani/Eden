#!/usr/bin/env bun
import { login, status, savings } from "./login";
import { wrapCmd } from "./wrap-cmd";
import { runHook } from "./hook";
import { runMcp } from "./mcp";
import { setup } from "./setup";
import { drain } from "./drain";
import { runHookd } from "./hookd";
import { playCli, fulfillCli, prefetchCli, recallCli } from "./play";
import { openTool, rejectTool } from "./open";
import { manifestCli } from "./manifest";
import { mcpHeaders } from "./headers";
import { doctor } from "./doctor";
import { bench } from "./bench";
import { auditCli } from "./audit";
import { archiveCli } from "./archive";
import { digestCli } from "./digest";
import { explainCli } from "./explain";
import { claimsCli } from "./claims";
import { approveCli, promoteCli } from "./approve";
import { knowCli } from "@eden/know";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "login") await login(rest);
else if (cmd === "status") await status();
else if (cmd === "wrap") await wrapCmd(rest);
else if (cmd === "hook") {
  // Overlap bind with the one-shot so PostToolBatch's process can exit
  // only after /health answers — the next PreToolUse is 1s curl, no bun.
  const hookdP = import("./hookd").then((m) => m.startHookdBackground());
  await runHook();
  await hookdP;
}
else if (cmd === "mcp") await runMcp();
else if (cmd === "setup") await setup(rest);
else if (cmd === "init") { const { init } = await import("./init"); await init(rest); }
else if (cmd === "import") { const { importTraces } = await import("./import"); await importTraces(rest); }
else if (cmd === "runner") { const { runner } = await import("./runner"); await runner(rest); }
else if (cmd === "drain") await drain();
else if (cmd === "hookd") await runHookd(rest);
else if (cmd === "play") await playCli(rest);
else if (cmd === "manifest") manifestCli(rest);
else if (cmd === "open") await openTool();
else if (cmd === "reject") process.exit(await rejectTool());
else if (cmd === "fulfill") await fulfillCli(rest);
else if (cmd === "prefetch") await prefetchCli(rest);
else if (cmd === "recall") await recallCli(rest);
else if (cmd === "mcp-headers") mcpHeaders();
else if (cmd === "doctor") process.exit(await doctor(rest));
else if (cmd === "savings") await savings();
else if (cmd === "bench") process.exit(await bench(rest));
else if (cmd === "audit") process.exit(await auditCli(rest));
else if (cmd === "archive") process.exit(await archiveCli(rest));
else if (cmd === "digest") process.exit(await digestCli(rest));
else if (cmd === "explain") process.exit(await explainCli(rest));
else if (cmd === "claims") process.exit(await claimsCli(rest));
else if (cmd === "approve") process.exit(await approveCli(rest));
else if (cmd === "promote") process.exit(await promoteCli(rest));
else if (cmd === "schedule") { const { scheduleCli } = await import("./schedule"); process.exit(await scheduleCli(rest)); }
else if (cmd === "know") process.exit(await knowCli(rest));
else {
  console.log(`eden — compile your agent's repeated tool patterns into single-call tools

Quick start:
  eden init          Set up config, hooks, and MCP in one step
  eden wrap          Start the local proxy (point OPENAI_BASE_URL at it)
  eden import -f <file>   Import existing traces from LangSmith/OTel/JSONL
  eden doctor        Check that everything is healthy
  eden doctor --tree Wave 16–20 leftover letter
  eden explain       Why nothing compiled (exact counts)
  eden claims        Published limits board (wins, analogue, limits, retired)

Recording:
  eden hookd         Start the recording daemon for Claude Code hooks
  eden hookd --stop  Stop the supervised daemon
  eden hook          Record a single tool call (called by hooks)
  eden drain         Flush pending recordings

Tools:
  eden play <name>   Manually invoke a compiled tool
  eden approve <id>  Print the diff card; --yes ships canary
  eden promote <id>  Promote a canary tool to Live (100%)
  eden schedule <id> --cron "…"  Operator cron for a live tool (does not Approve)
  eden open          Open the workshop card
  eden reject        Decline the first-stretch knock
  eden savings        Show cumulative savings
  eden bench          Run benchmarks

Advanced:
  eden login         Authenticate with a hosted Eden instance
  eden status        Show current configuration
  eden fulfill      Batch fulfillment from a plan file
  eden recall       Recall previously prefetched results
  eden audit export  Write approvals, versions, executions, refusals (JSONL or CSV)
  eden audit review  Who approved what, when, which version (tenant-bound)
  eden audit verify  Check a hash-chained export; fails closed on tamper
  eden archive status   Counts per hot/warm/cold tier
  eden archive compact  Move eligible runs hot → warm → cold
  eden digest        Weekly letter that mirrors Home (opt-in; EDEN_DIGEST=1)
  eden claims        Published limits board (analogue labeled; limits not wins)
  eden doctor --tree Wave 16–20 leftover letter (Wave 21–22 stay Next)
  eden know run      Continuous web ingest onto the Know graph (free, robots-ok)
`);
  process.exit(cmd ? 1 : 0);
}
