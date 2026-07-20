/**
 * Wave 29 — packaging + portal sweep + ChatSidebar/Observe structural gates.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readApiModules } from "./_read-api";

const ROOT = resolve(__dirname, "../../..");
const REPO = resolve(ROOT, "../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const repo = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

describe("W29 F22 /fix purge still holds", () => {
  it("has no live /issues/[id]/fix page", () => {
    expect(
      existsSync(resolve(ROOT, "src/app/(portal)/issues/[id]/fix/page.tsx")),
    ).toBe(false);
    expect(
      existsSync(resolve(ROOT, "src/app/(portal)/issues/[id]/fix")),
    ).toBe(false);
  });

  it("redirects /fix to handoff", () => {
    const cfg = src("../next.config.ts");
    expect(cfg).toContain("/issues/:id/fix");
    expect(cfg).toContain("tab=handoff");
  });

  it("api has no /fix/chat path", () => {
    const api = readApiModules(ROOT);
    expect(api).not.toContain("/fix/chat");
  });
});

describe("W29 ChatSidebar + Observe structural suites", () => {
  it("keeps ChatSidebar golden suites (W20–W23)", () => {
    for (const f of [
      "w20-portal.test.ts",
      "w21-portal.test.ts",
      "w22-portal.test.ts",
      "w23-portal.test.ts",
    ]) {
      expect(existsSync(resolve(ROOT, `src/lib/__tests__/${f}`))).toBe(true);
    }
    const w23 = readFileSync(
      resolve(ROOT, "src/lib/__tests__/w23-portal.test.ts"),
      "utf8",
    );
    expect(w23).toContain("W23 golden chat structural suite");
    expect(w23).toContain("propose_filter");
    expect(w23).toContain("CitationChip");
  });

  it("keeps Observe hubs (traces / issues / alerts)", () => {
    for (const hub of ["traces", "issues", "alerts"]) {
      expect(
        existsSync(resolve(ROOT, `src/app/(portal)/${hub}/page.tsx`)),
      ).toBe(true);
    }
  });

  it("ChatSidebar shell still mounts useChatSidebar", () => {
    const shell = src("components/ai-insights/ChatSidebar.tsx");
    expect(shell).toContain("useChatSidebar");
  });
});

describe("W29 publish + declaration artifacts", () => {
  it("ships publish_sdk + portal sweep scripts", () => {
    for (const rel of [
      "scripts/publish_sdk.sh",
      "scripts/w29_portal_sweep.sh",
      "scripts/w29_mcp_smoke.sh",
      "scripts/w29_flag_dr_drills.sh",
    ]) {
      const p = resolve(REPO, rel);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).mode & 0o111).toBeTruthy();
    }
  });

  it("ships SOTA declaration + perf/cost scorecard", () => {
    expect(existsSync(resolve(REPO, "docs/specs/SOTA-DECLARATION.md"))).toBe(
      true,
    );
    expect(
      existsSync(resolve(REPO, "docs/specs/SOTA-PERF-COST-SCORECARD.md")),
    ).toBe(true);
    const decl = repo("docs/specs/SOTA-DECLARATION.md");
    expect(decl).toMatch(/PARTIAL|GREEN/);
    expect(decl).toContain("Definition of Done");
  });

  it("SDK versions synced at 0.3.x", () => {
    const py = repo("sdk/python/pyproject.toml");
    const m = py.match(/^version\s*=\s*"([^"]+)"/m);
    expect(m?.[1]).toMatch(/^0\.3\./);
    const ts = JSON.parse(repo("sdk/ts-ai/package.json"));
    expect(ts.version).toBe(m?.[1]);
  });
});
