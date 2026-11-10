/**
 * The pilot's import (F3, D489): what a user's read-only sources hold, read once through the same `Source` interface
 * Eden reads (D7: the connectors' own read-only check has already run), every text through `sanitizeForStore` (D10)
 * before it is kept. Each source's listing is read newest first up to a cap; a source with no listing (the Google
 * Calendar preset) is read by searching for the owner's queries (their tasks' own words by default), as a lookup
 * would. Nothing is sent anywhere: the only network calls are the connectors' reads.
 */
import type { ContextItem, Scope } from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import type { Source } from "@eden/sources";
import type { PilotItem, PilotMeta } from "./store";

/** As the engine's cache caps an item's text. */
export const MAX_TEXT_CHARS = 8_000;
const PAGE = 100;
const SEARCH_LIMIT = 20;
const CALL_TIMEOUT_MS = 30_000;

export interface ImportOptions {
  /** Most items kept per source. Default 2,000 (the cache's per-user cap). */
  maxItems?: number;
  /** Searched on every source, beside its listing: the tasks' texts, names the owner adds. */
  queries?: readonly string[];
  /** The lab connector id each source is served as in runs (`gmail`, `calendar`, `drive`); default: by its id. */
  serveAs?: (source: Source) => string;
  now?: () => number;
  log?: (line: string) => void;
}

/** The lab's connector ids (its latency profiles are keyed by them). */
export const LAB_SOURCES = ["gmail", "calendar", "drive", "crm", "slack"] as const;

/** A source's lab connector id, read from its own id or description: mail, a calendar, else documents. */
export function labSourceOf(source: Pick<Source, "id" | "description">): string {
  if ((LAB_SOURCES as readonly string[]).includes(source.id)) return source.id;
  const about = `${source.id} ${source.description}`.toLowerCase();
  if (/mail|inbox/.test(about)) return "gmail";
  if (/calendar|event|caldav/.test(about)) return "calendar";
  if (/slack|chat/.test(about)) return "slack";
  if (/crm|deal/.test(about)) return "crm";
  return "drive";
}

/** One text through the secret gate, and whether it changed. */
function redact(text: string, count: { redacted: boolean }): string {
  const out = sanitizeForStore(text);
  if (out !== text) count.redacted = true;
  return out;
}

export async function importSources(
  sources: readonly Source[],
  scope: Scope,
  user: PilotMeta["user"],
  options: ImportOptions = {},
): Promise<{ meta: PilotMeta; items: PilotItem[] }> {
  const maxItems = options.maxItems ?? 2_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const serveAs = options.serveAs ?? labSourceOf;
  const items: PilotItem[] = [];
  const meta: PilotMeta = { user, importedAt: now(), sources: {}, counts: {} };
  for (const source of sources) {
    const sourceId = serveAs(source);
    const seen = new Set<string>();
    const count = (meta.counts[sourceId] ??= { items: 0, redacted: 0 });
    meta.sources[sourceId] ??= source.description;
    const keep = (found: readonly ContextItem[]) => {
      for (const it of found) {
        // Two sources served as one connector keep their refs apart.
        const ref = sourceId === source.id ? it.ref : `${source.id}:${it.ref}`;
        if (seen.size >= maxItems || seen.has(ref)) continue;
        seen.add(ref);
        const flag = { redacted: false };
        const meta0 = it.meta;
        const updatedAt = Number(it.updatedAt ?? now());
        items.push({
          sourceId,
          ref: redact(ref, flag),
          title: redact(String(it.title ?? ""), flag),
          text: redact(String(it.text ?? "").slice(0, MAX_TEXT_CHARS), flag),
          ...(typeof it.url === "string" ? { url: redact(it.url, flag) } : {}),
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : now(),
          ...(meta0
            ? { meta: Object.fromEntries(Object.entries(meta0).map(([k, v]) => [k, redact(String(v), flag)])) }
            : {}),
        });
        count.items++;
        if (flag.redacted) count.redacted++;
      }
    };
    try {
      if (source.list) {
        let cursor: string | undefined;
        while (seen.size < maxItems) {
          const page = await source.list(scope, cursor, PAGE, AbortSignal.timeout(CALL_TIMEOUT_MS));
          keep(page.items);
          if (!page.next || page.items.length === 0) break;
          cursor = page.next;
        }
      }
      for (const text of options.queries ?? []) {
        if (seen.size >= maxItems) break;
        const query = { scope, text, entities: [], limit: SEARCH_LIMIT };
        keep(await source.search(query, AbortSignal.timeout(CALL_TIMEOUT_MS)));
      }
    } catch (e) {
      // One source failing leaves what the others gave; the message may quote a URL, so it goes through the gate.
      log(`${source.id}: stopped: ${sanitizeForStore(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
    log(`${source.id} (as ${sourceId}): ${seen.size} items${source.list ? "" : " (no listing: searches only)"}`);
  }
  return { meta, items };
}
