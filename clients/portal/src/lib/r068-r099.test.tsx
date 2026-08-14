// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageHeader } from "@/components/ds/primitives";
import { SettingsModeNav, settingsModeHref } from "@/lab/settings/settings-chrome";
import { FilterChips, SearchInput } from "@/lab/lab-ui";
import { readFileSync } from "node:fs";
import path from "node:path";

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

describe("R068–R077 Settings chrome", () => {
  it("settingsModeHref maps query and path tabs", () => {
    expect(settingsModeHref("workspace")).toBe("/settings");
    expect(settingsModeHref("keys")).toBe("/settings?mode=keys");
    expect(settingsModeHref("members")).toBe("/settings?mode=members");
    expect(settingsModeHref("audit")).toBe("/settings?mode=audit");
    expect(settingsModeHref("roles")).toBe("/settings/roles");
    expect(settingsModeHref("sso")).toBe("/settings/sso");
    expect(settingsModeHref("pii")).toBe("/settings/pii");
    expect(settingsModeHref("scim")).toBe("/settings/scim");
  });

  it("SettingsModeNav selects only the active tab", () => {
    render(<SettingsModeNav value="roles" />);
    const tabs = screen.getAllByRole("tab");
    const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toBe("Roles");
    expect(screen.getByRole("tab", { name: "SSO" }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("SettingsModeNav items are links with stable hrefs", () => {
    render(<SettingsModeNav value="keys" />);
    expect(screen.getByRole("tab", { name: "API keys" }).getAttribute("href")).toBe(
      "/settings?mode=keys",
    );
    expect(screen.getByRole("tab", { name: "Roles" }).getAttribute("href")).toBe(
      "/settings/roles",
    );
  });

  it("PageHeader wraps string meta so it can truncate", () => {
    const { container } = render(
      <PageHeader title="SSO" meta="Native SSO for self-hosted orgs" />,
    );
    expect(container.querySelector(".type-meta")?.textContent).toBe(
      "Native SSO for self-hosted orgs",
    );
  });
});

describe("R072 SearchInput", () => {
  it("pads the field so the icon does not cover the placeholder", () => {
    render(
      <SearchInput
        value=""
        onChange={() => undefined}
        ariaLabel="Search runs"
        placeholder="Search runs, ids, agents…"
      />,
    );
    const input = screen.getByRole("searchbox", { name: "Search runs" });
    expect(input.className).toMatch(/pl-9/);
  });
});

describe("R081 FilterChips", () => {
  it("hides orphan zero counts when every option is 0", () => {
    render(
      <FilterChips
        value="all"
        onChange={() => undefined}
        options={[
          { id: "all", label: "All", count: 0 },
          { id: "error", label: "Failed", count: 0 },
        ]}
      />,
    );
    expect(screen.getByRole("tab", { name: "All" }).textContent).toBe("All");
    expect(screen.getByRole("tab", { name: "Failed" }).textContent).toBe("Failed");
  });

  it("shows counts once any option is non-zero", () => {
    render(
      <FilterChips
        value="all"
        onChange={() => undefined}
        options={[
          { id: "all", label: "All", count: 2 },
          { id: "error", label: "Failed", count: 0 },
        ]}
      />,
    );
    expect(screen.getByRole("tab", { name: /All/ }).textContent).toMatch(/2/);
  });
});


describe("R076 / R080 / R085 / R093 / R099 source locks", () => {
  const portal = path.join(process.cwd(), "src");

  it("playgrounds empty CTA says New playground", () => {
    const src = readFileSync(
      path.join(portal, "app/(portal)/playgrounds/page.tsx"),
      "utf8",
    );
    expect(src).toMatch(/New playground/);
    expect(src).not.toMatch(/Create playground/);
  });

  it("evals compare copy is grammatical", () => {
    const src = readFileSync(
      path.join(portal, "lab/evals/evals-compare-view.tsx"),
      "utf8",
    );
    expect(src).toMatch(/Comparison needs finished eval runs/);
    expect(src).not.toMatch(/Compare needs finished eval runs/);
    expect(src).toMatch(/aria-label="Dataset"/);
  });

  it("traces Failed empty uses a Clear filters button", () => {
    const src = readFileSync(
      path.join(portal, "app/(portal)/traces/traces-client.tsx"),
      "utf8",
    );
    expect(src).toMatch(/No failed traces/);
    expect(src).toMatch(/Clear filters/);
    expect(src).toMatch(/severityFilter !== "all"/);
  });

  it("gateway Show includes a count", () => {
    const src = readFileSync(
      path.join(portal, "app/(portal)/gateway/gateway-client.tsx"),
      "utf8",
    );
    expect(src).toMatch(/Show \{registry\.length \+ byModel\.length\}/);
    expect(src).toMatch(/\{title \? <h2/);
  });

  it("danger zone is visually separated after prefs", () => {
    const src = readFileSync(
      path.join(portal, "lab/settings/settings-workspace-view.tsx"),
      "utf8",
    );
    expect(src).toMatch(/data-testid="danger-zone"/);
    expect(src).toMatch(/type-label">Density[\s\S]*data-testid="danger-zone"/);
  });

  it("cost page links back to Settings", () => {
    const src = readFileSync(
      path.join(portal, "app/(portal)/cost/cost-client.tsx"),
      "utf8",
    );
    expect(src).toMatch(/href="\/settings"/);
    expect(src).toMatch(/Plan &amp; budget|Plan & budget/);
  });

  it("roles page lists built-in Owner/Admin/Member/Viewer", () => {
    const src = readFileSync(
      path.join(portal, "app/(portal)/settings/roles/page.tsx"),
      "utf8",
    );
    expect(src).toMatch(/Built-in roles/);
    expect(src).toMatch(/Owner/);
    expect(src).toMatch(/Admin/);
    expect(src).toMatch(/Member/);
    expect(src).toMatch(/Viewer/);
  });

  it("SSO header meta is short and +Add is not in the header", () => {
    const src = readFileSync(
      path.join(portal, "app/(portal)/settings/sso/page.tsx"),
      "utf8",
    );
    expect(src).toMatch(/Native SSO for self-hosted orgs/);
    expect(src).toMatch(/Manage in Clerk/);
    expect(src).not.toMatch(/\+ Add provider/);
  });

  it("attach dataset closes on Escape and restores focus", () => {
    const src = readFileSync(
      path.join(portal, "lab/playgrounds/dataset-attach-dialog.tsx"),
      "utf8",
    );
    expect(src).toMatch(/e\.key === "Escape"/);
    expect(src).toMatch(/el\.focus\(\)/);
  });

  it("debugger Open traces is outline not primary", () => {
    const src = readFileSync(
      path.join(portal, "lab/debugger/debugger-list-view.tsx"),
      "utf8",
    );
    expect(src).toMatch(/Open traces[\s\S]*ds-btn-outline|ds-btn-outline[\s\S]*Open traces/);
    expect(src).toMatch(/ds-btn-primary[\s\S]*New session|New session[\s\S]*ds-btn-primary/);
  });

  it("account menu includes Command palette", () => {
    const src = readFileSync(
      path.join(portal, "components/shell/portal-auth-chrome.tsx"),
      "utf8",
    );
    expect(src).toMatch(/Command palette/);
    expect(src).toMatch(/openCommandPalette/);
  });

  it("autonomy mode patch toasts Autonomy set to", () => {
    const src = readFileSync(
      path.join(portal, "lab/settings/autonomy-settings-card.tsx"),
      "utf8",
    );
    expect(src).toMatch(/Autonomy set to \$\{m\.label\}/);
    expect(src).toMatch(/Earned autonomy unavailable/);
  });

  it("group loading is not a 4-card KPI grid (R073)", () => {
    const src = readFileSync(
      path.join(portal, "app/(portal)/loading.tsx"),
      "utf8",
    );
    expect(src).toMatch(/variant="well"/);
    expect(src).not.toMatch(/grid-cols-4/);
  });
});
