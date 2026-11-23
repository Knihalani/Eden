/**
 * A built-in source over local files (A3): directories and glob patterns become items — one config
 * line in a sources file, no connector to run. Each `list`/`search` rescans paths and re-reads only
 * files whose mtime or size changed; a deleted file reports gone by ref.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
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

/** One text read of a file, or null for binary/unreadable: text is cut at maxBytes. */
function readText(path: string, maxBytes: number): string | null {
  try {
    const buf = readFileSync(path);
    const sniff = buf.subarray(0, BINARY_SNIFF);
    if (sniff.includes(0)) return null;
    return buf.subarray(0, maxBytes).toString("utf8");
  } catch {
    return null;
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

  /** Rescan: re-read files whose mtime or size changed, drop the missing. Rebuilds the term index. */
  private scan(): void {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const e of this.entries) for (const p of matchPaths(e)) if (!seen.has(p)) (seen.add(p), next.push(p));
    let dirty = false;
    for (const path of next.slice(0, this.maxFiles)) {
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      const old = this.held.get(path);
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
      const text = readText(path, this.maxBytes);
      if (text === null) {
        if (old) this.held.delete(path);
        dirty ||= old !== undefined;
        continue;
      }
      dirty = true;
      this.held.set(path, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        doc: {
          ref: path,
          title: basename(path),
          text,
          url: `file://${path}`,
          updatedAt: st.mtimeMs,
          meta: { dir: dirname(path), ext: extname(path), size: String(st.size) },
        },
      });
    }
    for (const p of [...this.held.keys()]) {
      if (!seen.has(p)) {
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
    return this.inner!.search(query);
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
    if (!existsSync(ref)) return null;
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
