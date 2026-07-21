/**
 * Wave 1.9 — Ghosts soft-hide (roles / SSO).
 *
 * Soft-hide contract (Ghosts A / R10 M6):
 * - `roles` and `sso` live in GHOST_TABS only — never in the TABS rail,
 *   category pills, or ⌘K promotion.
 * - Deep-link `?tab=roles|sso` → quiet notice → safe daily tab (org/overview).
 * - Do not invent Roles/SSO product UI until backend ships.
 */
// export const WS1_GHOSTS_COMPLETED = true;

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GHOST_TABS, TABS } from "../_components/settings-tab-registry";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

const REGISTRY_REL = "app/(portal)/settings/_components/settings-tab-registry.ts";
const PAGE_REL = "app/(portal)/settings/page.tsx";

describe("Wave 1.9 ghosts soft-hide", () => {
  const registry = read(REGISTRY_REL);
  const page = read(PAGE_REL);

  it("keeps GHOST_TABS roles+sso soft-hide present", () => {
    expect([...GHOST_TABS].sort()).toEqual(["roles", "sso"]);
    expect(registry).toContain("GHOST_TABS");
    expect(registry).toMatch(/GHOST_TABS\s*=\s*new Set\(\[\s*"roles"\s*,\s*"sso"\s*\]\)/);
    expect(page).toContain("GHOST_TABS");
    expect(page).toContain("ghostNotice");
  });

  it("excludes roles/sso from TABS rail ids", () => {
    const railIds = TABS.map((t) => t.id);
    expect(railIds).not.toContain("roles");
    expect(railIds).not.toContain("sso");
    expect(registry).not.toMatch(/id:\s*"roles"/);
    expect(registry).not.toMatch(/id:\s*"sso"/);
  });

  it("documents the soft-hide contract", () => {
    expect(registry).toMatch(/Soft-launch ghosts|intentionally absent from TABS/);
    expect(registry).toMatch(/quiet notice|without advertising/);
    const design = read("../DESIGN.md");
    expect(design).toContain("### Ghosts soft-hide (Roles / SSO)");
    expect(design).toContain("Ghosts A");
    expect(design).toMatch(/`roles`, `sso`/);
  });

  it("page still handles ghost deep-links with quiet notice", () => {
    expect(page).toMatch(/GHOST_TABS\.has/);
    expect(page).toContain("SSO not available yet");
    expect(page).toContain("Custom roles not available yet");
    expect(page).toContain("data-ws1-ghost-notice");
  });
});
