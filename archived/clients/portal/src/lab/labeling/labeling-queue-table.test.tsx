import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LabelingQueueTable } from "@/lab/labeling/labeling-queue-table";
import type { LabelingQueue } from "@/lib/api/labeling";

function queue(overrides: Partial<LabelingQueue> = {}): LabelingQueue {
  return {
    id: "q1",
    org_id: "org-1",
    name: "Toxicity review",
    description: "Flag toxic completions",
    schema: {},
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("LabelingQueueTable", () => {
  it("renders an empty state with no queues", () => {
    render(<LabelingQueueTable queues={[]} onSelect={vi.fn()} />);
    expect(screen.getByText(/no labeling queues yet/i)).toBeInTheDocument();
  });

  it("calls onSelect with the queue id when a row is clicked", () => {
    const onSelect = vi.fn();
    render(<LabelingQueueTable queues={[queue()]} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Toxicity review"));
    expect(onSelect).toHaveBeenCalledWith("q1");
  });
});
