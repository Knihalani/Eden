/**
 * Fails when a line is longer than Prettier's printWidth (.prettierrc.json).
 *
 * `prettier --check` alone does not enforce the width. Prettier wraps code but
 * never breaks a comment, a string, a template or a regex literal. Comments
 * can always be rewrapped by hand, so they must fit. Literals are the one
 * exception: splitting one changes the program's tokens, which a formatting
 * rule must not require. Most long literals in live code are split by hand
 * anyway, but some must stay whole: a test title, so it can be found by
 * searching for it; public copy, which packages/measure/src/publish-check.ts
 * scans line by line; a Next.js route's `config`, which Next reads without
 * running it; and benchmarks/memory-long-horizon/, whose tree hash
 * (harness_sha) slice preregistrations pin. So a line may exceed the width
 * only by the literals on it: strings, regexes and the text of templates. The
 * code in a template's `${…}` still counts.
 *
 * Usage: bun scripts/check-line-length.ts <file>...
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

export type OverlongLine = { line: number; length: number };

/** Length in code points, so one emoji counts as one character. */
const lengthOf = (s: string) => [...s].length;

/**
 * [start, end) of every literal's text. For a template that is the text
 * between its substitutions: the code inside `${…}` is code, and must fit.
 */
function literalSpans(source: ts.SourceFile): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const add = (node: ts.Node) => spans.push([node.getStart(source), node.end]);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isRegularExpressionLiteral(node)) {
      add(node);
    } else if (ts.isTemplateExpression(node)) {
      add(node.head);
      for (const span of node.templateSpans) {
        visit(span.expression);
        add(span.literal);
      }
    } else node.forEachChild(visit);
  };
  visit(source);
  return spans;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Lines longer than `width` once the literals on them are left out. */
export function overlongLines(path: string, text: string, width: number): OverlongLine[] {
  // A line's length in code points is at most its length in UTF-16 units, so a file with no line over `width` units
  // has nothing to report: it is not parsed. Parsing every file was most of format:check's line check (4.8 s of CPU
  // for 874 files; most have no long line).
  if (!text.split("\n").some((line) => line.length > width)) return [];
  let literals: Array<[number, number]> | undefined;
  const spans = () =>
    (literals ??= literalSpans(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path))));
  const found: OverlongLine[] = [];
  let lineStart = 0;
  text.split("\n").forEach((line, index) => {
    const lineEnd = lineStart + line.length;
    const length = lengthOf(line);
    if (length > width) {
      const literalLength = spans()
        .filter(([start, end]) => start < lineEnd && end > lineStart)
        .reduce(
          (sum, [start, end]) => sum + lengthOf(text.slice(Math.max(start, lineStart), Math.min(end, lineEnd))),
          0,
        );
      if (length - literalLength > width) found.push({ line: index + 1, length });
    }
    lineStart = lineEnd + 1;
  });
  return found;
}

if (import.meta.main) {
  const { printWidth } = JSON.parse(readFileSync(".prettierrc.json", "utf8")) as { printWidth: number };
  let count = 0;
  for (const path of process.argv.slice(2)) {
    for (const { line, length } of overlongLines(path, readFileSync(path, "utf8"), printWidth)) {
      console.error(`${path}:${line}: ${length} characters (limit ${printWidth})`);
      count++;
    }
  }
  if (count > 0) {
    console.error(`${count} line(s) over ${printWidth} characters outside literals. Rewrap comments by hand.`);
    process.exit(1);
  }
}
