import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResourcePageShell } from "../ResourcePageShell";

describe("ResourcePageShell chrome bands", () => {
  it("marks identity band and page-bands=1 when only header is present", () => {
    const { container } = render(
      <ResourcePageShell header={<h1>Agents</h1>} table={<div>table</div>} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-page-bands", "1");
    expect(root.querySelector('[data-chrome-band="identity"]')).toBeTruthy();
    expect(root.querySelector('[data-chrome-band="toolbar"]')).toBeNull();
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  it("marks toolbar band and page-bands=2 when toolbar is present", () => {
    const { container } = render(
      <ResourcePageShell
        header={<h1>Traces</h1>}
        toolbar={<div>filters</div>}
        table={<div>table</div>}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-page-bands", "2");
    expect(root.querySelector('[data-chrome-band="identity"]')).toBeTruthy();
    expect(root.querySelector('[data-chrome-band="toolbar"]')).toBeTruthy();
  });

  it("kpi strip gets chrome-band=kpi without bumping page-bands to 3", () => {
    const { container } = render(
      <ResourcePageShell
        header={<h1>Fleet</h1>}
        toolbar={<div>toolbar</div>}
        kpiStrip={<div>kpis</div>}
        table={<div>table</div>}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-page-bands", "2");
    expect(root).toHaveAttribute("data-has-kpi", "");
    expect(root.querySelector('[data-chrome-band="kpi"]')).toBeTruthy();
    expect(screen.getByText("kpis")).toBeInTheDocument();
  });
});
