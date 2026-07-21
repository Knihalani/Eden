/**
 * Wave 9 — Shell finish + dual-route hygiene (M1, M9, M12, S14, S17).
 * LOC gate, daily ≤6, ghosts soft-hide, stub redirects, ⌘K parity.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function lineCount(rel: string): number {
  const src = read(rel);
  if (src.length === 0) return 0;
  return src.split("\n").length - (src.endsWith("\n") ? 1 : 0);
}

const DUAL_STUBS = [
  "exports",
  "gateway",
  "pii",
  "retention",
  "sidebar",
  "status",
] as const;

describe("WS9 shell hygiene — LOC + daily + ghosts", () => {
  const registry = read("app/(portal)/settings/_components/settings-tab-registry.ts");
  const pageRel = "app/(portal)/settings/page.tsx";

  it("settings hub shell ≤400 LOC (M1)", () => {
    expect(lineCount(pageRel)).toBeLessThanOrEqual(400);
  });

  it("exports WS9_SHELL_HYGIENE_COMPLETED", () => {
    expect(registry).toContain("WS9_SHELL_HYGIENE_COMPLETED = true");
  });

  it("daily defaultVisible ≤6", () => {
    const defaults = [...registry.matchAll(/defaultVisible:\s*true/g)];
    expect(defaults.length).toBeLessThanOrEqual(6);
    expect(registry).toContain("WAVE9_DAILY_TAB_CAP = 6");
  });

  it("soft-hides roles/sso ghosts", () => {
    expect(registry).toMatch(/GHOST_TABS\s*=\s*new Set\(\[\s*"roles"\s*,\s*"sso"\s*\]\)/);
    expect(registry).not.toMatch(/id:\s*"roles"/);
    expect(registry).not.toMatch(/id:\s*"sso"/);
  });

  it("no second 240px settings rail in hub or loading", () => {
    const page = read(pageRel);
    const loading = read("app/(portal)/settings/loading.tsx");
    expect(page).not.toContain("lg:w-[240px]");
    expect(page).not.toContain("w-[240px]");
    expect(loading).not.toContain("lg:w-[240px]");
    expect(loading).not.toContain("w-[240px]");
  });
});

describe("WS9 dual-route stubs redirect-only (S14)", () => {
  for (const stub of DUAL_STUBS) {
    it(`/settings/${stub} is redirect-only`, () => {
      const src = read(`app/(portal)/settings/(tabs)/${stub}/page.tsx`);
      expect(src).toContain("router.replace");
      const targetsHub =
        src.includes(`/settings?tab=${stub}`) ||
        src.includes(`"tab", "${stub}"`) ||
        src.includes(`'tab', '${stub}'`);
      expect(targetsHub).toBe(true);
      expect(src).not.toMatch(
        /PageHeader|PageContent|ExportsTab|PiiPolicyTab|RetentionPolicyTab|SidebarSettingsView|StatusTab/,
      );
    });
  }

  it("webhooks-dlq FS route is redirect-only stub (S14)", () => {
    const src = read("app/(portal)/settings/(tabs)/webhooks-dlq/page.tsx");
    expect(src).toContain("router.replace");
    expect(src).toMatch(/webhooks-dlq/);
    expect(src).toContain("data-ws7-dlq-redirect");
    expect(src).not.toMatch(/PageHeader|PageContent/);
  });
});

describe("WS9 ⌘K parity (S17)", () => {
  const nav = read("lib/nav-commands.ts");

  it("includes overview + audit-trail commands", () => {
    expect(nav).toContain('href: "/settings"');
    expect(nav).toContain("Settings · Overview");
    expect(nav).toContain('href: "/audit-trail"');
    expect(nav).toContain("Audit trail");
    expect(nav).not.toContain('href: "/settings?tab=audit-log"');
    expect(nav).not.toContain('href: "/settings?tab=roles"');
    expect(nav).not.toContain('href: "/settings?tab=sso"');
  });
});
