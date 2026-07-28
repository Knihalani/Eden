/**
 * Every redirect destination must resolve to a real route.
 *
 * `next.config.ts` accumulated fourteen rules pointing at pages that were
 * planned and never built (`/analytics`, `/agents/:id`,
 * `/evals/datasets/:id`). Next.js does not validate destinations, so each
 * one silently sent users to the global catch-all 404 — strictly worse than
 * having no redirect, because the URL looked handled. Nothing failed; the
 * rules just quietly stopped working.
 *
 * This walks the real app tree and checks every destination against it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = join(__dirname, "../app");
const NEXT_CONFIG = join(__dirname, "../../next.config.ts");

/** Route-group segments like `(portal)` do not appear in URLs. */
const isGroup = (seg: string) => seg.startsWith("(") && seg.endsWith(")");

/** Collect URL patterns for every page.tsx, as arrays of segments. */
function collectRoutes(dir: string, prefix: string[] = []): string[][] {
  const routes: string[][] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      routes.push(...collectRoutes(full, isGroup(entry) ? prefix : [...prefix, entry]));
    } else if (entry === "page.tsx") {
      routes.push(prefix);
    }
  }
  return routes;
}

/** Does one filesystem route pattern match a concrete destination path? */
function matches(route: string[], target: string[]): boolean {
  let r = 0;
  let t = 0;
  while (r < route.length) {
    const seg = route[r]!;
    // [...slug] and [[...slug]] swallow the remainder.
    if (seg.startsWith("[[...") || seg.startsWith("[...")) return true;
    if (t >= target.length) return false;
    // [id] matches exactly one segment; :id in a destination is a param.
    if (!(seg.startsWith("[") && seg.endsWith("]")) && seg !== target[t]) {
      return false;
    }
    r += 1;
    t += 1;
  }
  return t === target.length;
}

function parseDestinations(config: string): { source: string; destination: string }[] {
  const out: { source: string; destination: string }[] = [];
  // Rules are object literals with source + destination, written both inline
  // and multi-line, so scan for each destination and pair it with the
  // nearest preceding source.
  const re = /source:\s*"([^"]+)"[\s\S]{0,200}?destination:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(config)) !== null) {
    out.push({ source: m[1]!, destination: m[2]! });
  }
  return out;
}

describe("next.config redirect destinations", () => {
  const config = readFileSync(NEXT_CONFIG, "utf8");
  const rules = parseDestinations(config);
  // `app/[...notFound]/page.tsx` is the global catch-all whose whole job is
  // to render the 404. It matches every path, so leaving it in this set
  // would make every destination look reachable and this test could never
  // fail -- which is exactly how the dead rules survived in the first place.
  const routes = collectRoutes(APP_DIR).filter(
    (route) => !route.some((seg) => seg === "[...notFound]"),
  );

  it("parses a plausible number of rules", () => {
    // Guards the regex itself: if the config format changes and this drops
    // to zero, the suite must fail loudly rather than vacuously pass.
    expect(rules.length).toBeGreaterThan(30);
    expect(routes.length).toBeGreaterThan(20);
  });

  it("every destination resolves to a real page", () => {
    const dead: string[] = [];
    for (const { source, destination } of rules) {
      // External destinations are out of scope.
      if (/^https?:\/\//.test(destination)) continue;
      const path = destination.split("?")[0]!.split("#")[0]!;
      const target = path.split("/").filter(Boolean);
      // Root is always served by (marketing)/page.tsx.
      if (target.length === 0) continue;
      if (!routes.some((route) => matches(route, target))) {
        dead.push(`${source} -> ${destination}`);
      }
    }
    expect(dead).toEqual([]);
  });
});
