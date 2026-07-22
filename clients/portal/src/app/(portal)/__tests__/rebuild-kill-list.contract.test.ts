/**
 * Phase 1 kill-list contract — engineering/02-kill-list.md greps.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(__dirname, "../../..");
const componentsRoot = path.join(srcRoot, "components");
const portalApp = path.join(srcRoot, "app/(portal)");

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "_archive" || name === "node_modules") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

describe("rebuild kill-list contract", () => {
  it("has no redteam page under (portal)", () => {
    expect(existsSync(path.join(portalApp, "redteam"))).toBe(false);
    expect(existsSync(path.join(portalApp, "redteam/page.tsx"))).toBe(false);
  });

  it("has no kill-list zombie product pages (redirects only)", () => {
    const zombies = [
      "fleet/page.tsx",
      "incidents/page.tsx",
      "signals/page.tsx",
      "inspector/page.tsx",
      "observability/page.tsx",
      "observability/mcp/page.tsx",
      "observability/decisions/page.tsx",
      "observability/memory/page.tsx",
      "observability/retrieval/page.tsx",
      "observability/time-travel/page.tsx",
      "observability/query/page.tsx",
      "observability/cohorts/page.tsx",
      "observability/eval/page.tsx",
      "datasets/page.tsx",
      "playgrounds/page.tsx",
      "experiments/page.tsx",
      "ledger/page.tsx",
      "promotions/page.tsx",
      "artifacts/page.tsx",
      "optimization/page.tsx",
      "optimization/budget/page.tsx",
    ];
    for (const rel of zombies) {
      expect(existsSync(path.join(portalApp, rel)), rel).toBe(false);
    }
  });

  it("has no EmbeddedSurface module under src/components", () => {
    const files = walkFiles(componentsRoot);
    const embedded = files.filter((f) =>
      /embedded-surface/i.test(path.basename(f)),
    );
    expect(embedded).toEqual([]);

    const hits = files.filter((f) => {
      if (!/\.(tsx?|jsx?)$/.test(f)) return false;
      const src = readFileSync(f, "utf8");
      return /\bEmbeddedSurface\b/.test(src);
    });
    expect(hits).toEqual([]);
  });

  it("has at most one CommandPalette module (ui/command-palette)", () => {
    const files = walkFiles(componentsRoot).filter((f) => {
      if (f.includes(`${path.sep}__tests__${path.sep}`)) return false;
      return /command-palette/i.test(path.basename(f));
    });
    const allowed = path.join(componentsRoot, "ui/command-palette.tsx");
    expect(files).toEqual([allowed]);
    expect(existsSync(allowed)).toBe(true);
  });

  it("has no TraceViewerModal under portal product sources", () => {
    const files = [
      ...walkFiles(portalApp),
      ...walkFiles(componentsRoot),
    ].filter((f) => {
      if (!/\.(tsx?|jsx?)$/.test(f)) return false;
      if (f.includes(`${path.sep}__tests__${path.sep}`)) return false;
      if (/\.(test|spec)\.(tsx?|jsx?)$/.test(f)) return false;
      return true;
    });
    const hits = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /\bTraceViewerModal\b/.test(src);
    });
    expect(hits).toEqual([]);
  });

  it("stub-chrome.tsx does not exist after Phase 1", () => {
    expect(
      existsSync(path.join(componentsRoot, "shell/stub-chrome.tsx")),
    ).toBe(false);
  });
});
