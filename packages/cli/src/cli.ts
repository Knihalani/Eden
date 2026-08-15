import { runHook } from "./hook";
import { runHookd } from "./hookd";
import { drain } from "./drain";
import { setup } from "./setup";
import { mcpHeaders } from "./headers";
import { openTool, rejectTool } from "./open";
import { playCli, recallCli, prefetchCli, fulfillCli } from "./play";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "hook") await runHook();
else if (cmd === "hookd") await runHookd();
else if (cmd === "drain") await drain();
else if (cmd === "setup") await setup(rest);
else if (cmd === "mcp-headers") mcpHeaders();
else if (cmd === "open") await openTool();
else if (cmd === "reject") await rejectTool();
else if (cmd === "play") await playCli(rest);
else if (cmd === "recall") await recallCli(rest);
else if (cmd === "prefetch") await prefetchCli(rest);
else if (cmd === "fulfill") await fulfillCli(rest);
else {
  console.log(`eden ${cmd || ""}
commands: setup | hook | hookd | drain | mcp-headers | open | reject | play | recall | fulfill`);
  process.exit(cmd ? 1 : 0);
}
