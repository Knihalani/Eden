#!/usr/bin/env bun
/**
 * 20-line agent: wrap one tool. Compiled facts win; wrap down or miss runs original.
 */
import { runTool } from "../../packages/sdk-js/src/index.ts";

async function lookupTicket(_name: string, args: Record<string, unknown>) {
  return { id: args.id, original: true };
}

const facts = await runTool("lookupTicket", { id: "T-100" }, lookupTicket);
console.log(JSON.stringify(facts));
