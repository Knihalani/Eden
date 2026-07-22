/**
 * Phase 7 Audit contract — surfaces/audit.md acceptance (hub chrome / IA).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreNavLeaves } from "@/lib/sidebar-config";
import { AUDIT_TABS } from "@/app/(portal)/audit/_components/audit-tabs";

const portalSrc = path.resolve(__dirname, "../../../..");
const auditRoot = path.join(portalSrc, "app/(portal)/audit");
const nextConfig = path.join(portalSrc, "../next.config.ts");
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

describe("rebuild audit contract", () => {
  it("required hub routes and panels exist", () => {
    expect(existsSync(path.join(auditRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(auditRoot, "loading.tsx"))).toBe(true);
    expect(
      existsSync(path.join(auditRoot, "_components/events-panel.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(auditRoot, "_components/packs-panel.tsx")),
    ).toBe(true);
  });

  it("tabs events | packs; Generate pack CTA; kit only", () => {
    expect([...AUDIT_TABS]).toEqual(["events", "packs"]);
    const page = readFileSync(path.join(auditRoot, "page.tsx"), "utf8");
    expect(page).toContain("events");
    expect(page).toContain("packs");
    expect(page).toContain("ResourcePageShell");
    expect(page).toContain("/settings?tab=retention");
    expect(page).toContain("/settings?tab=pii");
    expect(page).not.toContain("EmbeddedSurface");

    const packs = readFileSync(
      path.join(auditRoot, "_components/packs-panel.tsx"),
      "utf8",
    );
    expect(packs).toContain("Generate pack");
    expect(packs).toContain("exportPack");
    expect(packs).toContain("PacksPanel");
    expect(packs).not.toMatch(/cryptographically verified/i);

    for (const f of walkTs(auditRoot)) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toContain("EmbeddedSurface");
      expect(src).not.toMatch(/red-?team/i);
    }
  });

  it("sidebar audit href is live /audit", () => {
    const audit = getCoreNavLeaves().find((i) => i.id === "audit");
    expect(audit?.href).toBe("/audit");
  });

  it("softLand excludes /audit; /audit-trail redirects to /audit", () => {
    const cfg = readFileSync(nextConfig, "utf8");
    const softLandBody = cfg.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBody).not.toMatch(/"\/audit"/);
    expect(softLandBody).not.toMatch(/"\/audit-trail"/);
    expect(cfg).toMatch(/source: ["']\/audit-trail["']/);
    expect(cfg).toMatch(/destination: ["']\/audit["']/);
  });

  it("i18n audit namespace present in en and de", () => {
    const en = JSON.parse(readFileSync(enMessages, "utf8")) as {
      audit?: { title?: string; tabs?: { events?: string; packs?: string } };
    };
    const de = JSON.parse(readFileSync(deMessages, "utf8")) as {
      audit?: { title?: string; tabs?: { events?: string; packs?: string } };
    };
    expect(en.audit?.title).toBeTruthy();
    expect(de.audit?.title).toBeTruthy();
    expect(en.audit?.tabs?.events).toBeTruthy();
    expect(de.audit?.tabs?.packs).toBeTruthy();
  });
});
