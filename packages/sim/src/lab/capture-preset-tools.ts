#!/usr/bin/env bun
/**
 * C1 follow-up (D415): from the lab servers behind the `caldav` and `obsidian` connector presets, captures every
 * tool's metadata (`tools/list`), one search reply that returns at least two items, each candidate get-by-id tool's
 * reply for two of those items, and each listing tool's first page. The data is the simulated world's (seed 1000),
 * never a real account's; replies are trimmed to the two items.
 *
 *   bun packages/sim/src/lab/capture-preset-tools.ts packages/sources/src/fixtures/lab-preset-tools.json
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildWorld } from "../world";
import { CONNECTORS, ensureNetwork, removeLabContainers } from "./connectors";

type Call = { tool: string; arguments: Record<string, unknown> };
type Row = Record<string, unknown>;
type Plan = {
  connector: string;
  query: string;
  /** The candidate get-by-id calls for one row of the search reply. */
  gets: (row: Row) => Call[];
  /** Listing calls (first page each). */
  lists: (window: { start: string; end: string }) => Call[];
};

/** The rows of a reply whose one text block is a JSON array (both servers answer so). */
const rowsOf = (reply: unknown): Row[] => {
  const r = reply as { content?: unknown };
  const t = ((r.content as { type: string; text?: string }[]) ?? [])[0]?.text ?? "[]";
  const v = JSON.parse(t) as unknown;
  return Array.isArray(v) ? (v as Row[]) : [];
};
/** A reply with its one JSON-array text block cut to its first `n` rows (the fixture stays small). */
const trimmed = (reply: unknown, n: number) => {
  const r = reply as { content?: unknown };
  const blocks = (r.content as { type: string; text?: string }[]) ?? [];
  return {
    ...r,
    content: blocks.map((b) => {
      const v = b.text ? (JSON.parse(b.text) as unknown) : undefined;
      return Array.isArray(v) ? { ...b, text: JSON.stringify(v.slice(0, n), null, 2), trimmedFrom: v.length } : b;
    }),
  };
};

const PLANS: Plan[] = [
  {
    connector: "caldav",
    query: "Robin Carter",
    gets: (row) => [{ tool: "caldav_get_event_by_uid", arguments: { uid: row.uid } }],
    lists: (w) => [{ tool: "caldav_get_events", arguments: { start_date: w.start, end_date: w.end } }],
  },
  {
    connector: "mcpvault",
    query: "Jamie Fox",
    gets: (row) => [
      { tool: "read_note", arguments: { path: row.p } },
      // The ref Eden takes from a search row (its `uri`, the first id key it holds), sent as schema-args would.
      { tool: "read_note", arguments: { path: row.uri } },
      { tool: "read_multiple_notes", arguments: { paths: [row.p] } },
      { tool: "get_notes_info", arguments: { paths: [row.p] } },
    ],
    lists: () => [
      { tool: "get_vault_stats", arguments: { recentCount: 5 } },
      { tool: "list_directory", arguments: { path: "/" } },
    ],
  },
];

const out: Record<string, unknown> = {};
const world = buildWorld({ seed: 1000 });

async function capture(plan: Plan): Promise<Record<string, unknown>> {
  const c = CONNECTORS[plan.connector]!();
  const rec: Record<string, unknown> = { connector: plan.connector };
  try {
    await c.setup(
      world.items.filter((i) => c.accepts(i)),
      world,
    );
    const client = new Client({ name: "cap", version: "0" });
    await client.connect(c.transport());
    const tools = (await client.listTools()).tools;
    rec.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations ?? null,
    }));
    const s = { tool: c.searchTool.name, arguments: c.searchTool.args(plan.query, 20) };
    const sr = await client.callTool({ name: s.tool, arguments: s.arguments });
    const rows = rowsOf(sr).slice(0, 2);
    rec.search = { ...s, isError: sr.isError ?? false, reply: trimmed(sr, 2) };
    rec.gets = [];
    for (const row of rows) {
      for (const g of plan.gets(row)) {
        const gr = await client.callTool({ name: g.tool, arguments: g.arguments });
        (rec.gets as unknown[]).push({ ...g, isError: gr.isError ?? false, reply: gr });
      }
    }
    rec.lists = [];
    const window = { start: String(s.arguments.start_date ?? ""), end: String(s.arguments.end_date ?? "") };
    for (const l of plan.lists(window)) {
      const lr = await client.callTool({ name: l.tool, arguments: l.arguments });
      (rec.lists as unknown[]).push({ ...l, isError: lr.isError ?? false, reply: trimmed(lr, 2) });
    }
    await client.close();
  } catch (e) {
    rec.error = String(e);
  }
  await c.teardown().catch(() => {});
  removeLabContainers();
  return rec;
}

ensureNetwork();
for (const p of PLANS) out[p.connector] = await capture(p);
writeFileSync(process.argv[2]!, JSON.stringify(out, null, 1));
