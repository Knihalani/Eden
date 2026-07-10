#!/usr/bin/env node
/**
 * Migrate portal page outer wrappers to PageContent.
 *
 * SAFETY RULES (read before running):
 * 1. Only transforms return blocks whose outer `<div>` contains `PageHeader`
 *    — this targets the main page body, not loader/error early returns.
 * 2. Skips files that already import PageContent.
 * 3. One-liner returns (`return <PageContent …>`) close with `</PageContent>;`
 *    — not `);`. Parenthesized returns close with `</PageContent>\n  );`.
 * 4. For loader branches, use PageLoading / PageContent manually instead.
 *
 * Usage: `node scripts/migrate-page-content.mjs` from clients/portal/
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function walk(dir, acc = []) {
  for (const ent of readdirSync(dir)) {
    const p = path.join(dir, ent);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (ent === "page.tsx") acc.push(p);
  }
  return acc;
}

const OPEN_RE =
  /return\s*(?:\(\s*)?<div className="([^"]*p-4 sm:p-6 lg:p-8[^"]*)">/g;

function sizeFromClass(cls) {
  if (cls.includes("max-w-7xl") || cls.includes("max-w-[1600px]")) return "wide";
  if (cls.includes("max-w-2xl") || cls.includes("max-w-3xl")) return "narrow";
  if (cls.includes("max-w-none")) return "full";
  return "default";
}

function findDivClose(src, openTagStart) {
  const tagEnd = src.indexOf(">", openTagStart);
  if (tagEnd === -1) return -1;
  let depth = 1;
  let i = tagEnd + 1;
  const openDiv = /<div[\s>]/g;
  const closeDiv = /<\/div>/g;
  while (i < src.length && depth > 0) {
    openDiv.lastIndex = i;
    closeDiv.lastIndex = i;
    const nextOpen = openDiv.exec(src);
    const nextClose = closeDiv.exec(src);
    if (!nextClose) return -1;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      i = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      if (depth === 0) return nextClose.index;
      i = nextClose.index + nextClose[0].length;
    }
  }
  return -1;
}

function migrateFile(file) {
  let src = readFileSync(file, "utf8");
  if (src.includes("PageContent")) return false;
  if (!src.includes("PageHeader")) return false;

  let best = null;
  OPEN_RE.lastIndex = 0;
  let m;
  while ((m = OPEN_RE.exec(src)) !== null) {
    const hadParen = /return\s*\(\s*<div/.test(src.slice(m.index, m.index + 24));
    const openTagStart = m.index + m[0].indexOf("<div");
    const closeStart = findDivClose(src, openTagStart);
    if (closeStart === -1) continue;
    const block = src.slice(openTagStart, closeStart + "</div>".length);
    if (!block.includes("PageHeader")) continue;
    const len = block.length;
    if (!best || len > best.len) {
      best = { m, hadParen, openTagStart, closeStart, len, size: sizeFromClass(m[1]) };
    }
  }
  if (!best) return false;

  const { hadParen, openTagStart, closeStart, size } = best;
  const before = src.slice(0, openTagStart);
  const after = src.slice(closeStart + "</div>".length);
  const openReplacement = hadParen
    ? `return (\n    <PageContent size="${size}">`
    : `return <PageContent size="${size}">`;
  const closeReplacement = hadParen ? "\n    </PageContent>\n  );" : "</PageContent>";
  let middle = src.slice(openTagStart, closeStart);
  middle = middle.replace(/^<div className="[^"]*">/, "");

  let out = before + openReplacement + middle + closeReplacement + after;

  if (!out.includes('from "@/components/layout/page-content"')) {
    out = out.replace(
      /import \{ PageHeader \} from "@\/components\/layout\/page-header";/,
      'import { PageHeader } from "@/components/layout/page-header";\nimport { PageContent } from "@/components/layout/page-content";',
    );
  }

  writeFileSync(file, out);
  return true;
}

let n = 0;
for (const file of walk(path.join(ROOT, "src/app/(portal)"))) {
  if (migrateFile(file)) {
    n++;
    console.log("migrated", path.relative(ROOT, file));
  }
}
console.log(`migrated ${n} files`);
