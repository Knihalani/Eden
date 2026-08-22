import { login, status, savings } from "./login";
import { wrapCmd } from "./wrap-cmd";
import { runHook } from "./hook";
import { runMcp } from "./mcp";
import { setup } from "./setup";
import { drain } from "./drain";
import { runHookd } from "./hookd";
import { playCli, fulfillCli, prefetchCli, recallCli } from "./play";
import { openTool, rejectTool } from "./open";
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
else if (cmd === "drain") await drain();
else if (cmd === "hookd") await runHookd();
else if (cmd === "play") await playCli(rest);
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
  console.log(`eden ${cmd || ""}
Point Eden at the agent you already have. We turn the repeating parts into one tool that cannot skip steps — and we show you what we refused.

commands: login | wrap | hook | hookd | mcp | status | setup | drain | play | open | fulfill | bench | doctor | savings`);
  process.exit(cmd ? 1 : 0);
}
