#!/usr/bin/env bun
/**
 * The end of a test run (scripts/test.sh, D811): the ten slowest files and every test over `SLOW_MS`, from the junit
 * reports of the run's parts. A test is given 20 s (`TEST_TIMEOUT_MS`) so that load cannot fail it; this keeps one
 * that grows slow in sight instead.
 *
 *   bun scripts/test-report.ts <junit.xml>...     missing files are skipped
 */
import { existsSync, readFileSync } from "node:fs";

/** 70% of Bun's own 5 s default: a test past it would be within 30% of the limit it used to have. */
export const SLOW_MS = 3_500;

export interface Timed {
  file: string;
  name: string;
  ms: number;
}

/** Files (top-level suites) and test cases, with their durations, from one junit report. */
export function parseJunit(xml: string): { files: Timed[]; tests: Timed[] } {
  const files: Timed[] = [];
  const tests: Timed[] = [];
  let file = "";
  for (const m of xml.matchAll(/<(testsuite|testcase)\b([^>]*)>/g)) {
    const attr = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(m[2]!)?.[1];
    const ms = Number(attr("time") ?? 0) * 1000;
    if (m[1] === "testsuite") {
      // Top-level suites are files: `name` and `file` agree and there is no `line` (describe blocks carry one).
      if (attr("name") === attr("file") && attr("line") === undefined) {
        file = attr("file") ?? "";
        files.push({ file, name: file, ms });
      }
    } else {
      tests.push({ file, name: unescape(attr("name") ?? ""), ms });
    }
  }
  return { files, tests };
}

const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

export function report(parts: { files: Timed[]; tests: Timed[] }[]): string[] {
  const files = parts.flatMap((p) => p.files).sort((a, b) => b.ms - a.ms);
  const slow = parts
    .flatMap((p) => p.tests)
    .filter((t) => t.ms > SLOW_MS)
    .sort((a, b) => b.ms - a.ms);
  if (files.length === 0) return [];
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const out = [
    "── slowest files: " +
      files
        .slice(0, 10)
        .map((f) => `${f.file} ${s(f.ms)}`)
        .join(", "),
  ];
  out.push(
    slow.length === 0
      ? `── no test over ${s(SLOW_MS)}`
      : `── tests over ${s(SLOW_MS)} (within 30% of Bun's 5 s default):`,
  );
  for (const t of slow) out.push(`   ${s(t.ms)}  ${t.file} > ${t.name}`);
  return out;
}

if (import.meta.main) {
  const parts = process.argv
    .slice(2)
    .filter((f) => existsSync(f))
    .map((f) => parseJunit(readFileSync(f, "utf8")));
  for (const line of report(parts)) console.log(line);
}
