/**
 * Fails when a line is longer than Prettier's printWidth (.prettierrc.json).
 *
 * `prettier --check` alone does not enforce the width. Prettier wraps code but
 * never breaks a comment, a string, a template or a regex literal. Comments
 * can always be rewrapped by hand, so they must fit. Literals are the one
 * exception: splitting one changes the program's tokens, which a formatting
 * rule must not require, and a test title or message split in two can no
 * longer be found by searching for it. So a line may exceed the width only by
 * the literals on it: strings, regexes and the text of templates. The code in
 * a template's `${…}` still counts.
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
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const literals = literalSpans(source);
  const found: OverlongLine[] = [];
  let lineStart = 0;
  text.split("\n").forEach((line, index) => {
    const lineEnd = lineStart + line.length;
    const length = lengthOf(line);
    if (length > width) {
      const literalLength = literals
        .filter(([start, end]) => start < lineEnd && end > lineStart)
        .reduce((sum, [start, end]) => sum + lengthOf(text.slice(Math.max(start, lineStart), Math.min(end, lineEnd))), 0);
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
