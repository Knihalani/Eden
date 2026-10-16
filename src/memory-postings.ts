/**
 * P4.2 (red first): the postings snapshot and the bounded candidate set (A4 §5.1 step 4c, D17). A stub: no snapshot
 * is written or read, and no candidate is chosen.
 */
import type { MemoryRecord } from "./index";
import type { Corpus, Field, RowFields } from "./memory-bm25f";

export const SNAPSHOT_FILE = "postings.snap";
export const CANDIDATE_CAP = 200;
export const FAT_DF = 64;
export const SNAPSHOT_DELTA = 256;

export interface Indexed {
  rec: MemoryRecord;
  readonly fields: RowFields;
}

export type RowFilter = ((row: MemoryRecord) => boolean) & { scopes?: (scope: string) => boolean };

interface Header {
  v: number;
  id: string;
  rows: number;
  ids: [number, number];
  buckets: [number, number][];
  scopes: Record<string, { n: number; len: Record<Field, number> }>;
}

export function snapshotBytes(_rows: readonly Indexed[]): Buffer {
  return Buffer.alloc(0);
}

export function writeSnapshot(_dir: string, _rows: readonly Indexed[]): void {}

export class Snapshot {
  private constructor(readonly header: Header) {}

  static open(_dir: string): Snapshot | undefined {
    return undefined;
  }

  ids(): string[] {
    return [];
  }

  lists(_term: string): Record<string, number[]> | undefined {
    return undefined;
  }

  close(): void {}
}

export class DeltaIndex<T extends Indexed> {
  constructor(
    readonly snapshot: string | undefined,
    readonly rows: readonly T[],
  ) {}
}

interface TermRows<T> {
  term: string;
  df: number;
  newest(): Iterable<T>;
}

export class PostingsView<T extends Indexed> implements Corpus {
  readonly n = 0;
  readonly avg = { value: 0, subject: 0, alias: 0, body: 0 };

  constructor(
    _snapshot: Snapshot | undefined,
    _delta: DeltaIndex<T>,
    _byId: (id: string) => T | undefined,
    _sees: (scope: string) => boolean,
  ) {}

  df(_term: string): number {
    return 0;
  }

  rowsOf(term: string): TermRows<T> {
    return { term, df: 0, newest: () => [] };
  }
}

export function candidateRows<T>(_terms: readonly TermRows<T>[], _accept: (row: T) => boolean, _cap = 200): T[] {
  return [];
}
