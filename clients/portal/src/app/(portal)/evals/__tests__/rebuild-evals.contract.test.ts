/**
 * Phase 4 Evals contract — surfaces/evals.md acceptance (hub chrome / IA).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreNavLeaves } from "@/lib/sidebar-config";

const portalSrc = path.resolve(__dirname, "../../../..");
const evalsRoot = path.join(portalSrc, "app/(portal)/evals");
const nextConfig = path.join(portalSrc, "../next.config.ts");
const killList = path.resolve(
  portalSrc,
  "../../../docs/portal-rebuild/engineering/02-kill-list.md",
);
const enMessages = path.join(portalSrc, "messages/en.json");
const deMessages = path.join(portalSrc, "messages/de.json");

function walkTs(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, acc);
    else if (/\.(tsx|ts)$/.test(name)) acc.push(full);
  }
  return acc;
}

describe("rebuild evals contract", () => {
  it("required hub routes and chrome exist", () => {
    expect(existsSync(path.join(evalsRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(evalsRoot, "loading.tsx"))).toBe(true);
    expect(
      existsSync(path.join(evalsRoot, "_components/evals-hub-toolbar.tsx")),
    ).toBe(true);
    expect(
      existsSync(
        path.join(portalSrc, "components/evals/add-to-dataset-dialog.tsx"),
      ),
    ).toBe(true);
  });

  it("hub tabs + keyboard + related strip + no EmbeddedSurface", () => {
    const page = readFileSync(path.join(evalsRoot, "page.tsx"), "utf8");
    expect(page).toContain("datasets");
    expect(page).toContain("playgrounds");
    expect(page).toContain("experiments");
    expect(page).toContain("labeling");
    expect(page).toContain("studio");
    expect(page).toContain("synthetic");
    expect(page).toContain("EvalScoresTab");
    expect(page).toContain("clearSelection");
    expect(page).toContain("EVALS_PRIMARY_TABS");
    expect(page).toContain("/issues");
    expect(page).toContain("/traces");
    expect(page).toContain("/improve");
    expect(page).toContain("/cost");
    expect(page).not.toContain("EmbeddedSurface");
    expect(page).not.toContain("useEmbeddedSurface");

    for (const f of walkTs(evalsRoot)) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toContain("EmbeddedSurface");
      expect(src).not.toContain("useEmbeddedSurface");
      expect(src).not.toMatch(/red-?team/i);
    }
  });

  it("sidebar evals href is live /evals", () => {
    const evals = getCoreNavLeaves().find((i) => i.id === "evals");
    expect(evals?.href).toBe("/evals");
  });

  it("softLand excludes /evals family; redirects source legacy leaves", () => {
    const cfg = readFileSync(nextConfig, "utf8");
    const softLandBody = cfg.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBody).not.toMatch(/"\/evals"/);
    expect(softLandBody).not.toMatch(/"\/datasets"/);
    expect(softLandBody).not.toMatch(/"\/playgrounds"/);
    expect(softLandBody).not.toMatch(/"\/experiments"/);
    expect(softLandBody).not.toMatch(/"\/labeling"/);
    expect(softLandBody).not.toMatch(/"\/studio"/);
    expect(softLandBody).not.toMatch(/"\/synthetic"/);

    expect(cfg).toMatch(/source: ["']\/datasets["']/);
    expect(cfg).toMatch(/destination: ["']\/evals\?tab=datasets["']/);
    expect(cfg).toMatch(/source: ["']\/playgrounds["']/);
    expect(cfg).toMatch(/destination: ["']\/evals\?tab=playgrounds["']/);
    expect(cfg).toMatch(/source: ["']\/experiments["']/);
    expect(cfg).toMatch(/destination: ["']\/evals\?tab=experiments["']/);
    expect(cfg).toMatch(/source: ["']\/labeling["']/);
    expect(cfg).toMatch(/source: ["']\/studio["']/);
    expect(cfg).toMatch(/source: ["']\/synthetic["']/);
  });

  it("kill-list still bans top-level datasets/playgrounds/experiments peers", () => {
    const kill = readFileSync(killList, "utf8");
    expect(kill).toMatch(/\/playgrounds/);
    expect(kill).toMatch(/\/experiments/);
    expect(kill).toMatch(/\/datasets/);
    expect(kill).toMatch(/Evals tab only|under Evals/i);
  });

  it("i18n evals namespace present in en and de", () => {
    const en = JSON.parse(readFileSync(enMessages, "utf8")) as {
      evals?: { title?: string; tabs?: { datasets?: string } };
    };
    const de = JSON.parse(readFileSync(deMessages, "utf8")) as {
      evals?: { title?: string; tabs?: { datasets?: string } };
    };
    expect(en.evals?.title).toBeTruthy();
    expect(de.evals?.title).toBeTruthy();
    expect(en.evals?.tabs?.datasets).toBeTruthy();
    expect(de.evals?.tabs?.datasets).toBeTruthy();
  });
});
