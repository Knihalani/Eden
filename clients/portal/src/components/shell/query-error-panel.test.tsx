// @vitest-environment jsdom
/**
 * Wave 13 — shared loading/empty primitives:
 *  - QueryLoadingPanel renders skeleton rows (not bare text) + role=status
 *  - EmptyState renders an optional icon in a ring
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import {
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { EmptyState } from "@/lab/lab-ui";

describe("QueryLoadingPanel (Wave 13 skeleton)", () => {
  it("renders skeleton rows with role=status and an aria-label", () => {
    const { container } = render(<QueryLoadingPanel label="Loading traces…" />);
    expect(screen.getByRole("status")).toHaveAccessibleName("Loading traces…");
    expect(container.querySelectorAll(".eden-skeleton-pulse").length).toBeGreaterThan(3);
  });
});

describe("EmptyState (Wave 13 icon slot)", () => {
  it("renders no icon glyph by default", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("Nothing here")).toBeTruthy();
  });

  it("renders the provided icon inside a ring when given one", () => {
    const { container } = render(<EmptyState title="No messages" icon={Inbox} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".rounded-full")).toBeTruthy();
  });
});

describe("QueryErrorPanel (Wave 13 icon anchor)", () => {
  it("shows an alert icon, the title, message, and retry for retryable errors", () => {
    const { container } = render(
      <QueryErrorPanel
        error={new Error("boom")}
        title="Couldn’t load data"
        onRetry={() => undefined}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("Couldn’t load data")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
