/**
 * The pilot's import (F3, D489): what a user's read-only sources hold, read once through the same `Source` interface
 * Eden reads (D7: the connectors' own read-only check has already run), every text through `sanitizeForStore` (D10)
 * before it is kept. Each source's listing is read newest first up to a cap; a source with no listing (the Google
 * Calendar preset) is read by searching for the owner's queries (their tasks' own words by default), as a lookup
 * would. Nothing is sent anywhere: the only network calls are the connectors' reads.
 */
import { sanitizeItem } from "@eden/engine";
import type { ContextItem, Scope } from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import type { Source } from "@eden/sources";
import type { PilotItem, PilotMeta } from "./store";

/** As the engine's cache caps an item's text. */
export const MAX_TEXT_CHARS = 8_000;
const PAGE = 100;
/** Listing pages read from one source at most: a server that keeps handing out a cursor does not hold the import. */
const MAX_PAGES = 1_000;
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

/**
 * An item as the pilot keeps it: made safe by the engine's own `sanitizeItem` (every field through the gate, the text
 * clipped so that a secret straddling the cut is still caught), its field names through the gate too.
 */
function safeItem(
  raw: ContextItem,
  sourceId: string,
  ref: string,
  now: number,
): { item: PilotItem; redacted: boolean } {
  const safe = sanitizeItem({ ...raw, ref }, MAX_TEXT_CHARS);
  const meta = safe.meta && Object.fromEntries(Object.entries(safe.meta).map(([k, v]) => [sanitizeForStore(k), v]));
  const updatedAt = Number(raw.updatedAt ?? now);
  const item: PilotItem = {
    sourceId,
    ref: safe.ref,
    title: safe.title,
    text: safe.text,
    ...(safe.url === undefined ? {} : { url: safe.url }),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
    ...(meta ? { meta } : {}),
  };
  // Redacted: the kept item carries more of the gate's marks than the source's own text did.
  const marks = (v: unknown) => JSON.stringify(v).split("[REDACTED]").length;
  return { item, redacted: marks(item) > marks([ref, raw.title, raw.text, raw.url, raw.meta]) };
}

export async function importSources(
  sources: readonly Source[],
  scope: Scope,
  user: PilotMeta["user"],
  options: ImportOptions = {},
): Promise<{ meta: PilotMeta; items: PilotItem[] }> {
  const maxItems = options.maxItems ?? 2_000;
  if (!Number.isInteger(maxItems) || maxItems < 1)
    throw new Error("the most items a source is a whole number, 1 or more");
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const serveAs = options.serveAs ?? labSourceOf;
  const items: PilotItem[] = [];
  const meta: PilotMeta = { user, importedAt: now(), sources: {}, counts: {} };
  for (const source of sources) {
    const sourceId = serveAs(source);
    const seen = new Set<string>();
    const count = (meta.counts[sourceId] ??= { items: 0, redacted: 0 });
    meta.sources[sourceId] ??= sanitizeForStore(source.description);
    /** Keeps the items not seen yet, up to the cap; returns how many were new. */
    const keep = (found: readonly ContextItem[]): number => {
      let added = 0;
      for (const it of found) {
        // Two sources served as one connector keep their refs apart.
        const ref = sourceId === source.id ? it.ref : `${source.id}:${it.ref}`;
        if (seen.size >= maxItems || seen.has(ref)) continue;
        seen.add(ref);
        const { item, redacted } = safeItem(it, sourceId, ref, now());
        items.push(item);
        added++;
        count.items++;
        if (redacted) count.redacted++;
      }
      return added;
    };
    try {
      if (source.list) {
        let cursor: string | undefined;
        for (let pages = 0; pages < MAX_PAGES && seen.size < maxItems; pages++) {
          const page = await source.list(scope, cursor, PAGE, AbortSignal.timeout(CALL_TIMEOUT_MS));
          // A page that adds nothing new ends the listing: a cursor that loops would otherwise never stop.
          if (keep(page.items) === 0 || !page.next) break;
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
