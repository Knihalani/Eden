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

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "login") await login(rest);
else if (cmd === "status") await status();
else if (cmd === "wrap") await wrapCmd(rest);
else if (cmd === "hook") await runHook();
else if (cmd === "mcp") await runMcp();
else if (cmd === "setup") await setup(rest);
else if (cmd === "init") { const { init } = await import("./init"); await init(rest); }
else if (cmd === "import") { const { importTraces } = await import("./import"); await importTraces(rest); }
else if (cmd === "runner") { const { runner } = await import("./runner"); await runner(rest); }
else if (cmd === "drain") await drain();
else if (cmd === "hookd") await runHookd();
else if (cmd === "play") await playCli(rest);
else if (cmd === "manifest") manifestCli(rest);
else if (cmd === "open") await openTool();
else if (cmd === "reject") await rejectTool();
else if (cmd === "fulfill") await fulfillCli(rest);
else if (cmd === "prefetch") await prefetchCli(rest);
else if (cmd === "recall") await recallCli(rest);
else if (cmd === "mcp-headers") mcpHeaders();
else if (cmd === "doctor") process.exit(await doctor(rest));
else if (cmd === "savings") await savings();
else if (cmd === "bench") process.exit(await bench(rest));
else {
  console.log(`eden — compile your agent's repeated tool patterns into single-call tools

Quick start:
  eden init          Set up config, hooks, and MCP in one step
  eden wrap          Start the local proxy (point OPENAI_BASE_URL at it)
  eden import -f <file>   Import existing traces from LangSmith/OTel/JSONL
  eden doctor        Check that everything is healthy

Recording:
  eden hookd         Start the recording daemon for Claude Code hooks
  eden hook          Record a single tool call (called by hooks)
  eden drain         Flush pending recordings

Tools:
  eden play <name>   Manually invoke a compiled tool
  eden savings        Show cumulative savings
  eden bench          Run benchmarks

Advanced:
  eden login         Authenticate with a hosted Eden instance
  eden status        Show current configuration
  eden fulfill      Batch fulfillment from a plan file
  eden recall       Recall previously prefetched results
`);
  process.exit(cmd ? 1 : 0);
}
