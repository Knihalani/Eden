#!/usr/bin/env bun
import { openMemory, host } from "./index";

const [cmd, ...args] = process.argv.slice(2);
const mem = openMemory({ dir: process.env.EDEN_MEMORY_DIR });

if (cmd === "remember") {
  const text = args.join(" ").trim();
  if (!text) {
    console.error("usage: remember <text>");
    process.exit(1);
  }
  console.log(JSON.stringify(mem.remember(text), null, 2));
} else if (cmd === "query") {
  console.log(JSON.stringify(mem.query(args.join(" ")), null, 2));
} else if (cmd === "inject") {
  const text = args.join(" ");
  console.log(JSON.stringify(mem.inject([{ role: "user", content: text }]), null, 2));
} else if (cmd === "list") {
  console.log(JSON.stringify(mem.memories(), null, 2));
} else if (cmd === "serve") {
  const port = Number(args[0] || process.env.PORT || 8787);
  const h = host({ port, dir: process.env.EDEN_MEMORY_DIR });
  console.log(h.url);
} else {
  console.error("usage: bun src/cli.ts remember|query|inject|list|serve");
  process.exit(1);
}
