/**
 * Connector presets (D294): one-line entries for common MCP servers in a user's source spec, so an integrator writes
 * `{"kind": "mcp", "preset": "gmail", "id": "mail", "url": …, "headers": {"Authorization": {"env": …}}}` instead of
 * working out which of a server's tools read and how their arguments map.
 *
 * A preset names only read tools: the search tool, and where the server has them a fetch-by-id tool and a listing for
 * the background sync, plus `fixed` arguments (a view, a format). It never names a write tool, so Eden cannot be told
 * to call one, and it never adds `trustedReadTools`: the read-only check (D7) still runs on every connect against
 * what the server itself declares, and a tool the server does not annotate `readOnlyHint: true` still fails the
 * connect until the operator, having checked it by hand, lists it in `trustedReadTools`. Explicit fields in the spec
 * win over the preset's.
 *
 * Where each preset's tool names and argument shapes come from is in `PRESETS[name].verified`: the input schemas the
 * server served (Google's hosted Gmail and Calendar servers, read on 2026-11-07; their annotations and replies were
 * not captured, `annotations`), or the connector lab's pinned
 * servers (`packages/sim/lab/servers.json`, captured in `@eden/sources`' fixtures). `connector-presets.test.ts` maps
 * every preset's tools against those schemas with the same `schema-args` code a connect runs.
 */
import type { McpSpec } from "./user-sources";

export interface ConnectorPreset {
  /** What the source holds, the default `description`. */
  description: string;
  /** The kind of account it reads, for docs and a picker. */
  area: "mail" | "calendar" | "notes" | "docs";
  searchTool: NonNullable<McpSpec["searchTool"]>;
  fetchTool?: McpSpec["fetchTool"];
  listTool?: McpSpec["listTool"];
  /** Where the tool names and schemas were checked. */
  verified: string;
  /**
   * What is known of the server's read-only annotations, when they were not captured with its schemas. Either way
   * the check runs on connect (D7): a tool not marked read-only fails it until the operator lists it by hand.
   */
  annotations?: string;
  /**
   * The preset's tools the server is known not to annotate read-only: the connect fails on them until the operator
   * checks the tool by hand and lists it in `trustedReadTools` (D7). The lab's note on why each only reads is here.
   */
  unannotated?: { tools: string[]; why: string };
  /**
   * Why the preset names no `fetchTool`, required when it names none (C1, D415). Without one the source cannot find
   * an item by ref (`fetchesById` false): its listing, if any, keeps the daily sweep (D356) and its doubted copies
   * are delivered as held (D126). An operator who has checked that both tools return the same copy may add one.
   */
  noFetch?: string;
}

export const PRESETS: Readonly<Record<string, ConnectorPreset>> = {
  gmail: {
    description: "The user's Gmail: mail threads, newest message of each",
    area: "mail",
    // THREAD_VIEW_SUMMARY: each thread's most recent message, since the latest word on a thread is what changes an
    // action (the default view shows its five oldest).
    searchTool: { name: "search_threads", fixed: { view: "THREAD_VIEW_SUMMARY" } },
    // search_threads with no query lists every thread, newest first, paged by pageToken: the sync's listing.
    listTool: { name: "search_threads", fixed: { view: "THREAD_VIEW_SUMMARY" } },
    verified: "Google's hosted Gmail MCP server: tools/list input schema of search_threads, 2026-11-07",
    noFetch:
      "get_thread returns every message of a thread (no messageFormat narrows it) where the summary view holds only " +
      "the newest, with messageCount (both tools' served descriptions, 2026-11-10): a re-read of an unchanged thread " +
      "of two or more messages would differ in its text and be sent as an update (D126, D205)",
    annotations: "not captured: if the server does not mark search_threads readOnlyHint, the connect is refused",
  },
  "google-calendar": {
    description: "The user's Google Calendar: events on their primary calendar",
    area: "calendar",
    searchTool: { name: "search_events" },
    // No listing: list_events pages by start time, not by change (D57). So no sync and no sweep (D356 does not apply).
    verified: "Google's hosted Calendar MCP server: tools/list input schema of search_events, 2026-11-07",
    noFetch:
      "get_event's input schema maps (eventId), but no reply of it or of search_events was captured: an event with " +
      "no description is held as its whole JSON, so a get_event copy that differs from the search copy in any field " +
      "would read as a change and be sent as an update (D205); with no listing, a fetch would only serve re-reads",
    annotations: "not captured: if the server does not mark search_events readOnlyHint, the connect is refused",
  },
  caldav: {
    description: "The user's CalDAV calendar (iCloud, Fastmail, Nextcloud, Radicale)",
    area: "calendar",
    searchTool: { name: "caldav_search_events" },
    verified: "madbonez/caldav-mcp at 6db4975 (connector lab, packages/sim/lab/servers.json)",
    noFetch: "the lab captured only caldav_search_events' schema: no fetch-by-id tool of this server could be verified",
    unannotated: {
      tools: ["caldav_search_events"],
      why: "fetches the window's events and filters them in memory (src/mcp_caldav/client.py:845-880 at 6db4975)",
    },
  },
  obsidian: {
    description: "The user's Obsidian-style notes vault",
    area: "notes",
    searchTool: { name: "search_notes", fixed: { limit: 20 } },
    verified: "bitbonsai/mcpvault at adda860 (connector lab, packages/sim/lab/servers.json)",
    noFetch: "the lab captured only search_notes' schema: no read-note tool of this server could be verified",
    unannotated: {
      tools: ["search_notes"],
      why: "only reads files (src/search.ts at adda860); run the server with --read-only as well",
    },
  },
};

export class UnknownPreset extends Error {}

/**
 * A spec with its preset's fields filled in (explicit fields win, `preset` dropped), or the spec unchanged when it
 * names none. Throws `UnknownPreset` naming the presets there are.
 */
export function expandPreset(spec: Record<string, unknown>): Record<string, unknown> {
  if (spec.preset === undefined) return spec;
  const name = spec.preset;
  const p = typeof name === "string" && Object.hasOwn(PRESETS, name) ? PRESETS[name]! : undefined;
  if (!p) {
    throw new UnknownPreset(`unknown preset ${JSON.stringify(name)} (presets: ${Object.keys(PRESETS).join(", ")})`);
  }
  const { preset: _, ...own } = spec;
  return {
    kind: "mcp",
    description: p.description,
    searchTool: p.searchTool,
    ...(p.fetchTool ? { fetchTool: p.fetchTool } : {}),
    ...(p.listTool ? { listTool: p.listTool } : {}),
    ...own,
  };
}
