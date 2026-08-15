import { runHook } from "./hook";
import { drain } from "./drain";
import { setup } from "./setup";
import { mcpHeaders } from "./headers";
import { openTool, rejectTool } from "./open";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "hook") await runHook();
else if (cmd === "drain") await drain();
else if (cmd === "setup") await setup(rest);
else if (cmd === "mcp-headers") mcpHeaders();
else if (cmd === "open") await openTool();
else if (cmd === "reject") await rejectTool();
else {
  console.log(`eden ${cmd || ""}
commands: setup | hook | drain | mcp-headers | open | reject`);
  process.exit(cmd ? 1 : 0);
}
