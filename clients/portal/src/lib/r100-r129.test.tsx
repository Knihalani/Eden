// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isExclusiveNavActive, PRIMARY_NAV } from "@/lab/nav";
import { statusLabel } from "@/lab/fixtures/guardrails";
import { SettingsModeNav } from "@/lab/settings/settings-chrome";
import { FilterChips } from "@/lab/lab-ui";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const portalSrc = path.resolve(__dirname, "..");

function src(rel: string) {
  return readFileSync(path.join(portalSrc, rel), "utf8");
}

describe("R100–R103 mobile", () => {
  it("Home Spend KPI is not hidden on small screens", () => {
    const home = src("app/(portal)/home/home-client.tsx");
    expect(home).toMatch(/label="Spend"/);
    expect(home).not.toMatch(/hidden sm:block/);
    expect(home).toMatch(/grid-cols-2/);
    expect(home).toMatch(/sm:grid-cols-4/);
  });

  it("Settings keys has a mobile list-or-detail branch", () => {
    const keys = src("lab/settings/settings-keys-view.tsx");
    expect(keys).toMatch(/mobilePane/);
    expect(keys).toMatch(/Back to keys/);
    expect(keys).toMatch(/ariaLabel="API key status"/);
  });

  it("SettingsModeNav tablist scrolls instead of clipping", () => {
    const chrome = src("lab/settings/settings-chrome.tsx");
    expect(chrome).toMatch(/overflow-x-auto/);
    expect(chrome).toMatch(/flex-nowrap/);
  });

  it("Traces help control stays shrink-0", () => {
    const traces = src("app/(portal)/traces/traces-client.tsx");
    expect(traces).toMatch(/Keyboard shortcuts/);
    expect(traces).toMatch(/ds-btn-icon shrink-0/);
  });
});

describe("R104–R111 a11y", () => {
  it("app-shell has a skip link targeting main", () => {
    const shell = src("components/shell/app-shell.tsx");
    expect(shell).toMatch(/Skip to main content/);
    expect(shell).toMatch(/href="#eden-main-content"/);
    expect(shell).toMatch(/id="eden-main-content"/);
  });

  it("only one exclusive nav item for /evals and /signals", () => {
    const hrefs = PRIMARY_NAV.map((i) => i.href);
    const evals = PRIMARY_NAV.filter((i) =>
      isExclusiveNavActive("/evals", i.href, hrefs),
    );
    const signals = PRIMARY_NAV.filter((i) =>
      isExclusiveNavActive("/signals", i.href, hrefs),
    );
    expect(evals).toHaveLength(1);
    expect(evals[0].href).toBe("/evals");
    expect(signals).toHaveLength(1);
    expect(signals[0].href).toBe("/signals");
  });

  it("focus-visible rings are at least 2px", () => {
    const css = src("styles/components.css");
    expect(css).toMatch(/outline: 2px solid var\(--accent\)/);
    expect(css).toMatch(/outline-offset: 2px/);
  });

  it("faint text token meets AA-ish floor on black", () => {
    const tokens = src("styles/tokens.css");
    expect(tokens).toMatch(/--eden-haze: #b0b0b0;/);
  });

  it("Settings tabs keep sentence-case multi-word labels", () => {
    render(<SettingsModeNav value="keys" />);
    expect(screen.getByRole("tab", { name: "API keys" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "PII policy" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "SSO" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "SCIM" })).toBeTruthy();
  });

  it("FilterChips tablists can have distinct names", () => {
    render(
      <FilterChips
        ariaLabel="API key status"
        value="all"
        onChange={() => {}}
        options={[
          { id: "all", label: "All", count: 0 },
          { id: "active", label: "Active", count: 0 },
        ]}
      />,
    );
    expect(screen.getByRole("tablist", { name: "API key status" })).toBeTruthy();
  });
});

describe("R112–R115 copy / onboarding / URLs", () => {
  it("cookie consent is a corner card, not full-bleed", () => {
    const cookie = src("components/cookie-consent.tsx");
    expect(cookie).not.toMatch(/inset-x-0/);
    expect(cookie).toMatch(/max-w-sm/);
    expect(cookie).toMatch(/bottom-3/);
  });

  it("traces persist search and severity in the URL", () => {
    const traces = src("app/(portal)/traces/traces-client.tsx");
    expect(traces).toMatch(/searchParams.get\("q"\)/);
    expect(traces).toMatch(/searchParams.get\("severity"\)/);
    expect(traces).toMatch(/patchQuery\(\{/);
  });

  it("portal customer UI has no British analyse", () => {
    const tour = src("components/onboarding/ProductTour.tsx");
    expect(tour).not.toMatch(/\banalyse\b/);
    const overlay = src("components/onboarding/OnboardingOverlay.tsx");
    expect(overlay).not.toMatch(/\banalyse\b/);
  });

  it("guardrail status chips are Title Case", () => {
    expect(statusLabel("active")).toBe("Active");
    expect(statusLabel("shadow")).toBe("Shadow");
    expect(statusLabel("disabled")).toBe("Off");
  });
});

describe("R116–R129 marketing fold", () => {
  it("keeps the headline with a boundary between sentences", () => {
    const hero = src("components/marketing/marketing-home-hero.tsx");
    expect(hero).toMatch(/See every agent run\./);
    expect(hero).toMatch(/Fix what fails\./);
    expect(hero).not.toMatch(/run\.Fix/);
    expect(hero).toMatch(/<br \/>/);
  });

  it("drops the hero mini metrics strip and giant wordmark", () => {
    const hero = src("components/marketing/marketing-home-hero.tsx");
    expect(hero).not.toMatch(/k: "Overhead"/);
    expect(hero).not.toMatch(/EdenLogo/);
    expect(hero).not.toMatch(/>\s*eden\s*</);
  });

  it("Get started is the primary signed-out CTA", () => {
    const ctas = src("components/marketing/marketing-auth-ctas.tsx");
    expect(ctas).toMatch(/Get started/);
    expect(ctas).toMatch(/ds-btn-primary/);
    expect(ctas).toMatch(/Sign in/);
    const signInBlock = ctas.slice(ctas.indexOf("Sign in") - 200, ctas.indexOf("Sign in"));
    expect(signInBlock).not.toMatch(/ds-btn-primary/);
  });

  it("pricing explains credits and keeps coming-soon inert", () => {
    const pricing = src("app/(marketing)/pricing/page.tsx");
    expect(pricing).toMatch(/A credit is a unit of billed gateway/);
    expect(pricing).toMatch(/disabled/);
    expect(pricing).toMatch(/Coming soon/);
  });

  it("docs no longer inject a fake FIND search", () => {
    const css = readFileSync(
      path.resolve(portalSrc, "../../../docs/src/css/custom.css"),
      "utf8",
    );
    expect(css).not.toMatch(/Find: ⌘\/Ctrl\+F/);
    const cfg = readFileSync(
      path.resolve(portalSrc, "../../../docs/docusaurus.config.js"),
      "utf8",
    );
    expect(cfg).toMatch(/label: 'Eden'/);
    expect(cfg).not.toMatch(/label: 'Portal'/);
  });

  it("marketing surfaces Status, Security, and DPA above the footer", () => {
    const sections = src("components/marketing/marketing-home-sections.tsx");
    expect(sections).toMatch(/href="\/status"/);
    expect(sections).toMatch(/href="\/security"/);
    expect(sections).toMatch(/href="\/dpa"/);
    expect(sections).toMatch(/detectors, issues, evals/);
  });
});
