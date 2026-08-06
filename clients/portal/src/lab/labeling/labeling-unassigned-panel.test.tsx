import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LabelingUnassignedPanel } from "@/lab/labeling/labeling-unassigned-panel";
import type { LabelingItemListEntry } from "@/lib/api/labeling";

function item(overrides: Partial<LabelingItemListEntry> = {}): LabelingItemListEntry {
  return {
    id: "item-1",
    prompt: "Rate this response",
    context: null,
    tags: [],
    source: "trace",
    created_at: "2026-01-01T00:00:00Z",
    annotations_count: 0,
    ...overrides,
  };
}

describe("LabelingUnassignedPanel", () => {
  it("renders an empty state with no items", () => {
    render(
      <LabelingUnassignedPanel
        items={[]}
        perItem={undefined}
        onSelect={vi.fn()}
        onStartLabeling={vi.fn()}
      />,
    );
    expect(screen.getByText(/no items in the pool/i)).toBeInTheDocument();
  });

  it("calls onSelect with the item id when a row is clicked", () => {
    const onSelect = vi.fn();
    render(
      <LabelingUnassignedPanel
        items={[item()]}
        perItem={undefined}
        onSelect={onSelect}
        onStartLabeling={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Rate this response"));
    expect(onSelect).toHaveBeenCalledWith("item-1");
  });

  it("calls onStartLabeling when the Start labeling button is clicked", () => {
    const onStartLabeling = vi.fn();
    render(
      <LabelingUnassignedPanel
        items={[]}
        perItem={undefined}
        onSelect={vi.fn()}
        onStartLabeling={onStartLabeling}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /start labeling/i }));
    expect(onStartLabeling).toHaveBeenCalledTimes(1);
  });

  it("shows the computed agreement score for items that have one", () => {
    render(
      <LabelingUnassignedPanel
        items={[item({ id: "a", annotations_count: 2 })]}
        perItem={{ a: { agreement: 0.42, kappa: 0.4 } }}
        onSelect={vi.fn()}
        onStartLabeling={vi.fn()}
      />,
    );
    expect(screen.getByText(/agreement 0\.42/i)).toBeInTheDocument();
  });
});
