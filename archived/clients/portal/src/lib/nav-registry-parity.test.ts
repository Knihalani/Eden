/**
 * Nav / registry / soft-land coherence.
 *
 * Three sources of truth describe the product surface and they have drifted
 * before: `lab/nav.ts` (the sidebar), `lab/registry.ts` (LAB_SURFACES, the
 * /rebuild review list) and `lib/stub-try-instead.ts` (the "Page moved"
 * suggestions). A nav leaf missing from LAB_SURFACES silently drops out of
 * review; a live route listed as a stub tells users a shipped page is dead.
 * This walks the real app tree so the checks track the filesystem, not a
 * hand-copied list.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRIMARY_NAV } from "@/lab/nav";
import { LAB_SURFACES } from "@/lab/registry";
import { STUB_TRY_INSTEAD } from "@/lib/stub-try-instead";

const APP_DIR = join(__dirname, "../app");

/** Route-group segments like `(portal)` do not appear in URLs. */
const isGroup = (seg: string) => seg.startsWith("(") && seg.endsWith(")");

/** URL paths for every page.tsx, e.g. "/evals", "/debugger/[id]". */
function collectPagePaths(dir: string, prefix: string[] = []): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      paths.push(
        ...collectPagePaths(full, isGroup(entry) ? prefix : [...prefix, entry]),
      );
    } else if (entry === "page.tsx") {
      paths.push(`/${prefix.join("/")}`);
    }
  }
  return paths;
}

// The global catch-all renders the 404 — it matches everything, so keeping
// it would make every path look live and these tests could never fail.
const PAGE_PATHS = collectPagePaths(APP_DIR).filter(
  (p) => !p.includes("[...notFound]"),
);

/** A path is live when a page exists at it or anywhere beneath it. */
function isLivePath(path: string): boolean {
  return PAGE_PATHS.some((p) => p === path || p.startsWith(`${path}/`));
}

describe("nav / LAB_SURFACES parity", () => {
  it("lists every sidebar leaf in LAB_SURFACES", () => {
    const surfaceHrefs = new Set(LAB_SURFACES.map((s) => s.href));
    const missing = PRIMARY_NAV.filter((i) => !surfaceHrefs.has(i.href)).map(
      (i) => i.href,
    );
    expect(missing).toEqual([]);
  });

  it("points every LAB_SURFACES href at a live page", () => {
    const dead = LAB_SURFACES.filter(
      (s) => !isLivePath(s.href.split("?")[0]!),
    ).map((s) => s.href);
    expect(dead).toEqual([]);
  });
});

describe("STUB_TRY_INSTEAD", () => {
  it("never claims a live route is dead", () => {
    // A key that ships as a real page (e.g. /playgrounds once it went live)
    // must be deleted from the map, or middleware soft-lands a shipped surface.
    const navHrefs = new Set(PRIMARY_NAV.map((i) => i.href));
    const wronglyDead = Object.keys(STUB_TRY_INSTEAD).filter(
      (key) => navHrefs.has(key) || isLivePath(key),
    );
    expect(wronglyDead).toEqual([]);
  });

  it("suggests only live destinations", () => {
    const dead = Object.entries(STUB_TRY_INSTEAD)
      .filter(([, { href }]) => !isLivePath(href.split("?")[0]!.split("#")[0]!))
      .map(([key, { href }]) => `${key} -> ${href}`);
    expect(dead).toEqual([]);
  });
});
