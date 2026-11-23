/**
 * A built-in source over local files (A3): directories and glob patterns become items — one config
 * line in a sources file, no connector to run. Each `list`/`search` rescans paths and re-reads only
 * files whose mtime or size changed; a deleted file reports gone by ref.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ContextItem, Scope } from "@eden/protocol";
import { itemId } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "./source";
import { StaticSource, type StaticDoc } from "./static-source";

export interface FileSourceSpec {
  /** Directory trees and/or glob patterns to index (e.g. "~/notes", "~/docs/**\/*.md"). ~ expands. */
  paths: string[];
  /** Bytes of one file indexed (default 512 KiB); a larger file's text is cut at it. */
  maxBytes?: number;
  /** Most files the source holds (default 10,000): the scan lists newest first past it. */
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 10_000;
/** A NUL in the first 4 KiB calls a file binary: not indexed (a photo, a build artefact). */
const BINARY_SNIFF = 4096;

interface Held {
  mtimeMs: number;
  size: number;
  doc: StaticDoc;
}

const isGlob = (p: string) => /[*?[\]{}]/.test(p);

const expand = (p: string) => {
  const t = p.trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/") || t.startsWith("~\\")) return join(homedir(), t.slice(2));
  return resolve(t);
};

/** Every file path a path entry names: a file itself, a directory's tree, a glob's matches. */
function matchPaths(entry: string): string[] {
  if (isGlob(entry)) {
    try {
      return [...new Bun.Glob(entry).scanSync({ absolute: true, onlyFiles: true, dot: false })];
    } catch {
      return [];
    }
  }
  try {
    const st = statSync(entry);
    if (st.isFile()) return [entry];
    if (!st.isDirectory()) return [];
    return [...new Bun.Glob("**/*").scanSync({ cwd: entry, absolute: true, onlyFiles: true, dot: false })];
  } catch {
    return [];
  }
}

/**
 * One text read of a file, or null for binary/unreadable: text is cut at maxBytes. At most maxBytes + 1
 * bytes are read — a giant file in a watched dir must not be loaded whole for the cut or the sniff.
 */
function readText(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(maxBytes + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const read = buf.subarray(0, n);
    if (read.subarray(0, BINARY_SNIFF).includes(0)) return null;
    return read.subarray(0, maxBytes).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class FileSource implements Source {
  readonly kind = "file";
  readonly callPriced = false;
  /** A missing file is gone for good, not "could not say". */
  readonly fetchReportsGone = true;
  readonly fetchesById = true;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly entries: string[];
  private held = new Map<string, Held>();
  /** Every path the last scan matched (in-spec), including ones the cap or a binary sniff left out. */
  private covered = new Set<string>();
  private inner: StaticSource | undefined;

  constructor(
    readonly id: string,
    readonly description: string,
    spec: FileSourceSpec,
  ) {
    this.maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = spec.maxFiles ?? DEFAULT_MAX_FILES;
    this.entries = spec.paths.map(expand);
  }

  /**
   * Rescan: re-read files whose mtime or size changed, drop the missing. The cap keeps the maxFiles
   * *newest* matches — cutting the scan order would keep whichever files sort first and never drop
   * held entries past it. Rebuilds the term index.
   */
  private scan(): void {
    const matched = new Set<string>();
    for (const e of this.entries) for (const p of matchPaths(e)) matched.add(p);
    const statred: { path: string; mtimeMs: number; size: number }[] = [];
    for (const path of matched) {
      try {
        const st = statSync(path);
        statred.push({ path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* vanished between glob and stat */
      }
    }
    statred.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.covered = new Set(statred.map((s) => s.path));
    const keep = new Set(statred.slice(0, this.maxFiles).map((s) => s.path));
    let dirty = false;
    for (const { path, mtimeMs, size } of statred.slice(0, this.maxFiles)) {
      const old = this.held.get(path);
      if (old && old.mtimeMs === mtimeMs && old.size === size) continue;
      const text = readText(path, this.maxBytes);
      if (text === null) {
        if (old) this.held.delete(path);
        dirty ||= old !== undefined;
        continue;
      }
      dirty = true;
      this.held.set(path, {
        mtimeMs,
        size,
        doc: {
          ref: path,
          title: basename(path),
          text,
          url: `file://${path}`,
          updatedAt: mtimeMs,
          meta: { dir: dirname(path), ext: extname(path), size: String(size) },
        },
      });
    }
    for (const p of [...this.held.keys()]) {
      if (!keep.has(p)) {
        this.held.delete(p);
        dirty = true;
      }
    }
    if (dirty || !this.inner) {
      const docs = [...this.held.values()]
        .sort((a, b) => (b.doc.updatedAt ?? 0) - (a.doc.updatedAt ?? 0))
        .map((h) => h.doc);
      this.inner = new StaticSource(this.id, this.description, docs);
    }
  }

  get listsByTime(): boolean {
    return true; // every item carries mtime, so a dated request can list what falls in its window
  }

  async search(query: SearchQuery, _signal: AbortSignal): Promise<ContextItem[]> {
    this.scan();
    const items = await this.inner!.search(query);
    // A file whose only date is its mtime still answers a dated lookup: inner's windowed match reads
    // meta.start and content dates, so the mtime day is added here — as a fall-back, never masking the
    // days a note's own text names (a meta.start would).
    const w = query.window;
    if (!w || items.length >= query.limit) return items;
    const have = new Set(items.map((i) => i.ref));
    for (const { doc, mtimeMs } of [...this.held.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      if (items.length >= query.limit) break;
      if (have.has(doc.ref)) continue;
      const day = new Date(mtimeMs).toISOString().slice(0, 10);
      if (day >= w.start && day < w.end) {
        items.push({ ...doc, id: itemId(this.id, doc.ref), sourceId: this.id });
      }
    }
    return items;
  }

  async list(_scope: Scope, cursor: string | undefined, limit: number, _signal: AbortSignal): Promise<ListPage> {
    this.scan();
    const docs = [...this.held.values()]
      .sort((a, b) => (b.doc.updatedAt ?? 0) - (a.doc.updatedAt ?? 0))
      .map((h) => h.doc);
    const from = cursor ? Number(cursor) : 0;
    const items = docs.slice(from, from + limit).map((d) => ({ ...d, id: itemId(this.id, d.ref), sourceId: this.id }));
    return { items, next: from + limit < docs.length ? String(from + limit) : null };
  }

  async fetch(ref: string, _scope: Scope, _signal: AbortSignal): Promise<ContextItem | null> {
    // Only refs the configured paths cover are ever opened: a pushed ref naming an arbitrary local
    // path (`/etc/passwd`) must not be read into an item (SEC: fetch is not a file API).
    this.scan();
    const held = this.held.get(ref);
    if (held) return { id: itemId(this.id, ref), sourceId: this.id, ...held.doc };
    // In-spec but not indexed — the cap kept newer files, or it turned binary then back to text: read
    // it on demand rather than report a matching file gone (that answer drops the cached item).
    if (!this.covered.has(ref)) return null;
    const st = statSync(ref);
    const text = readText(ref, this.maxBytes);
    if (text === null) return null;
    return {
      id: itemId(this.id, ref),
      sourceId: this.id,
      ref,
      title: basename(ref),
      text,
      url: `file://${ref}`,
      updatedAt: st.mtimeMs,
      meta: { dir: dirname(ref), ext: extname(ref), size: String(st.size) },
    };
  }
}
