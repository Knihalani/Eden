/**
 * Home Shell Wave 5 — Header, breadcrumbs, ⌘K.
 * Slim h-11 · kit Breadcrumb · Search…⌘K chip · empty palette = recents + Ask AI · no location triple.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BREADCRUMB_LABELS, buildBreadcrumbs } from "@/lib/breadcrumbs";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";
import { OPEN_AI_CHAT_HREF } from "@/lib/nav-commands";

const ROOT = resolve(__dirname, "../../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("W5 header — slim band + Search…⌘K", () => {
  it("PortalHeader is h-11 with visible Search… chip and Ask AI preserved", () => {
    const header = src("components/portal-chrome/PortalHeader.tsx");
    expect(header).toContain("h-11");
    expect(header).toContain('data-home-shell-header="slim"');
    expect(header).toContain("data-search-chip");
    expect(header).toContain("Search…");
    expect(header).toContain("⌘K");
    expect(header).toContain("data-ask-ai-header");
    expect(header).toContain("eden:ask-ai");
    expect(header).toContain('from "@/components/ui/breadcrumb"');
    // No inline crumb nav — kit owns location grammar.
    expect(header).not.toContain("GROUP_LABEL[crumb.category]");
  });

  it("kit breadcrumb supports home root, deep ellipsis, category prefix", () => {
    const crumb = src("components/ui/breadcrumb.tsx");
    expect(crumb).toContain("collapseDeep");
    expect(crumb).toContain("showCategoryPrefix");
    expect(crumb).toContain("homeHref");
    expect(crumb).toContain("GROUP_LABEL[crumb.category]");
    expect(crumb).toContain("…");
  });
});

describe("W5 breadcrumbs — sidebar IA sync", () => {
  it("Issues + Quickstart match sidebar labels; Home has no category", () => {
    const issues = DEFAULT_SIDEBAR.flatMap((g) => g.items).find((i) => i.id === "issues");
    expect(issues?.label).toBe("Issues");
    expect(BREADCRUMB_LABELS.issues?.label).toBe("Issues");
    expect(buildBreadcrumbs("/issues").at(-1)?.label).toBe("Issues");

    const docs = DEFAULT_SIDEBAR.flatMap((g) => g.items).find((i) => i.id === "docs");
    expect(docs?.label).toBe("Quickstart");
    expect(BREADCRUMB_LABELS.docs?.label).toBe("Quickstart");

    expect(BREADCRUMB_LABELS.dashboard?.label).toBe("Home");
    expect(BREADCRUMB_LABELS.dashboard?.category).toBeUndefined();
    expect(BREADCRUMB_LABELS.scorecard?.label).toBe("Scorecard");
  });
});

describe("W5 command palette — empty = recents + Ask AI", () => {
  it("pins Ask AI on empty and keeps single palette implementation", () => {
    const palette = src("components/ui/command-palette.tsx");
    expect(palette).toContain("OPEN_AI_CHAT_HREF");
    expect(palette).toContain('heading="Ask AI"');
    expect(palette).toContain('heading="Recent"');
    expect(palette).toContain("showPinnedAskAi");
    expect(palette).toContain("eden:ask-ai");
    expect(OPEN_AI_CHAT_HREF).toBe("eden:open-ai-chat");

    const reexport = src("components/portal-os/CommandPalette.tsx");
    expect(reexport).toContain("@/components/ui/command-palette");
    expect(reexport).not.toMatch(/function CommandPalette/);
  });
});

describe("W5 location triple — no PageHelpHint / eyebrow return", () => {
  it("PageHelpHint stays null; PageHeader does not render eyebrow", () => {
    const hint = src("components/layout/page-help-hint.tsx");
    expect(hint).toContain("return null");
    expect(hint).not.toMatch(/return\s*\(/);

    const pageHeader = src("components/layout/page-header.tsx");
    expect(pageHeader).toContain("eyebrow: _eyebrow");
    expect(pageHeader).not.toContain("{_eyebrow}");
    expect(pageHeader).not.toContain("{eyebrow}");
  });

  it("header is a single sticky band (≤2 with page toolbar)", () => {
    const header = src("components/portal-chrome/PortalHeader.tsx");
    expect(header).toContain("sticky top-0");
    // One location band only — no second sticky row inside header.
    expect(header.match(/sticky/g)?.length).toBe(1);
    expect(header.match(/<header/g)?.length).toBe(1);
  });
});
