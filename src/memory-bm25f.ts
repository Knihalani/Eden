/**
 * P4.2 (red first): BM25F (D17) for the lexical path. A stub: nothing is tokenized or scored yet.
 */
import type { MemoryRecord } from "./index";

export type Field = "value" | "subject" | "alias" | "body";
export const UNTYPED_NEEDLES = 12;
export type RowFields = Readonly<Record<Field, readonly string[]>>;

export interface Corpus {
  n: number;
  avg: Readonly<Record<Field, number>>;
  df(term: string): number;
}

export function rowFields(_rec: Pick<MemoryRecord, "text" | "tags" | "slots" | "cite" | "scope">): RowFields {
  return { value: [], subject: [], alias: [], body: [] };
}

export function rowTerms(_fields: RowFields): Set<string> {
  return new Set();
}

export function rankable(_rec: Pick<MemoryRecord, "tags">, _fields: RowFields): boolean {
  return false;
}

export function idf(_corpus: Corpus, _term: string): number {
  return 0;
}

export function termScore(_term: string, _fields: RowFields, _corpus: Corpus): number {
  return 0;
}

export function cueTerms(_tokens: Iterable<string>): Set<string> {
  return new Set();
}

export function promptTerms(_text: string): Set<string> {
  return new Set();
}
