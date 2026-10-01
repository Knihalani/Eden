import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_CLAIMS, customerStudies } from "./claims";
import {
  CLAIMS_LISTING_BANNER,
  claimNumberTokens,
  listingNumberTokens,
  renderClaimsListing,
} from "./listing";
import * as measure from "./index";

const ROOT = join(import.meta.dir, "../../..");

describe("claims-sourced marketplace listing", () => {
  test("customerStudies stays empty — fixtures are not customers", () => {
    expect(customerStudies()).toEqual([]);
    expect(customerStudies().length).toBe(0);
    expect(PUBLIC_CLAIMS.every((c) => c.approved !== true)).toBe(true);
  });

  test("barrel exports the claims renderer", () => {
    expect(typeof measure.renderClaimsListing).toBe("function");
    expect(measure.renderClaimsListing()).toBe(renderClaimsListing());
  });

  test("first line is withheld; draft is not a publish", () => {
    const draft = renderClaimsListing();
    expect(draft.startsWith(CLAIMS_LISTING_BANNER)).toBe(true);
    expect(CLAIMS_LISTING_BANNER).toMatch(/not published/i);
    expect(draft).toMatch(/unpublished/i);
    expect(draft).toMatch(/not a public listing/i);
    expect(draft).toMatch(/not a SOC 2 attestation/i);
    expect(draft).toMatch(/not submitted/i);
  });

  test("wins, parity, analogue, limits, retired each carry a PUBLIC_CLAIMS file path", () => {
    const draft = renderClaimsListing();
    for (const kind of ["win", "parity", "analogue", "limit", "retired"] as const) {
      const rows = PUBLIC_CLAIMS.filter((c) => c.kind === kind);
      expect(rows.length).toBeGreaterThan(0);
      for (const c of rows) {
        expect(draft).toContain(c.name);
        expect(draft).toContain(c.printed);
        expect(draft).toContain(c.statement);
        expect(draft).toContain(c.file);
      }
    }
  });

  test("every printed multiplier and percent maps to a PUBLIC_CLAIMS row", () => {
    const draft = renderClaimsListing();
    const allowed = claimNumberTokens();
    expect(allowed.size).toBeGreaterThan(0);
    const printed = listingNumberTokens(draft);
    expect(printed.length).toBeGreaterThan(0);
    for (const tok of printed) {
      expect(allowed.has(tok), tok).toBe(true);
    }
  });

  test("case studies are 0; fixture verticals are labeled not customers", () => {
    const draft = renderClaimsListing();
    expect(draft).toMatch(/Customer-approved measured studies: 0/);
    expect(draft).toMatch(/not customers/);
    expect(draft).toContain("support");
    expect(draft).toContain("desk");
    expect(draft).toContain("orders");
    expect(draft).toContain("etl");
    expect(draft).toContain("incident");
    expect(draft).not.toMatch(/\bN teams\b/i);
  });

  test("Determinism Index stays unpublished; needs an n we do not have", () => {
    const draft = renderClaimsListing();
    expect(draft).toMatch(/Determinism Index/);
    expect(draft).toMatch(/unpublished/);
    expect(draft).toMatch(/needs an n we do not have/i);
    expect(draft).toMatch(/ROADMAP §6/);
  });

  test("no company names, no SkillHub, no URL", () => {
    const draft = renderClaimsListing();
    expect(draft).not.toMatch(/https?:\/\//i);
    expect(draft).not.toMatch(/skillhub/i);
    expect(draft).not.toMatch(/\/v1\/listings/i);
    expect(draft).not.toMatch(/\b(Acme|Globex|Initech|Umbrella|Stark|Wayne|Stripe|Shopify|Salesforce|Netflix|Uber|Airbnb)\b/);
  });

  test("docs/marketplace-draft.md is the renderer output", () => {
    const path = join(ROOT, "docs/marketplace-draft.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(renderClaimsListing());
  });

  test("Determinism Index public page is absent", () => {
    expect(existsSync(join(ROOT, "apps/web/app/index/page.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "apps/web/app/(notes)/index/page.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "apps/web/app/(notes)/determinism/page.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "docs/determinism-index.md"))).toBe(false);
    const notes = join(ROOT, "apps/web/app");
    const stack = [notes];
    while (stack.length) {
      const dir = stack.pop()!;
      if (!existsSync(dir)) continue;
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "node_modules" || ent.name === ".next") continue;
          stack.push(p);
        } else if (ent.name === "page.tsx" || ent.name === "page.ts") {
          const src = readFileSync(p, "utf8");
          expect(src, p).not.toMatch(/Determinism\s+Index/i);
        }
      }
    }
  });
});

describe("ZDR guidance", () => {
  test("docs/zdr.md names Eden vs provider retention and refuses a cert claim", () => {
    const path = join(ROOT, "docs/zdr.md");
    expect(existsSync(path)).toBe(true);
    const zdr = readFileSync(path, "utf8");
    expect(zdr).toMatch(/EDEN_PROMPT_CACHE=0/);
    expect(zdr).toMatch(/allowed_callers/);
    expect(zdr).toMatch(/two agreeing outputs/);
    expect(zdr).toMatch(/config\.json/);
    expect(zdr).toMatch(/not a vault/i);
    expect(zdr).toMatch(/island \*\*memo\*\*/i);
    expect(zdr).toMatch(/island \*\*miss\*\*/i);
    expect(zdr).toMatch(/do not claim those calls are ZDR/i);
    expect(zdr).toMatch(/do not make Eden “ZDR.”|do not make Eden "ZDR\."/i);
    expect(zdr).toMatch(/Never claim .Eden is ZDR certified/);
    expect(zdr).toMatch(/guidance, not a badge/i);
    expect(zdr).toMatch(/docs\.anthropic\.com\/en\/docs\/build-with-claude\/zero-data-retention/);
  });
});
