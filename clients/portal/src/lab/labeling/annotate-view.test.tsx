import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnnotateView } from "@/lab/labeling/annotate-view";
import type { LabelingItem } from "@/lib/api/labeling";

function baseItem(overrides: Partial<LabelingItem> = {}): LabelingItem {
  return {
    id: "item-1",
    org_id: "org-1",
    payload: { foo: "bar" },
    label_schema: { options: ["good", "bad", "unclear"] },
    prompt: "Was this response helpful?",
    status: "leased",
    tags: ["qa"],
    annotations_required: 1,
    required_skills: [],
    source_trace_id: "trace-123",
    source_span_id: "span-456",
    source_dataset_id: null,
    source_synthetic_qa_id: null,
    assigned_to: "user-1",
    ...overrides,
  };
}

function renderView(overrides: Partial<Parameters<typeof AnnotateView>[0]> = {}) {
  const props = {
    item: baseItem(),
    label: null as unknown,
    onLabelChange: vi.fn(),
    confidence: 0.8,
    onConfidenceChange: vi.fn(),
    notes: "",
    onNotesChange: vi.fn(),
    onSubmit: vi.fn(),
    onSkip: vi.fn(),
    submitting: false,
    skipping: false,
    remaining: 3,
    ...overrides,
  };
  render(<AnnotateView {...props} />);
  return props;
}

describe("AnnotateView keyboard shortcuts", () => {
  it("pressing 2 selects the second label option", () => {
    const props = renderView();
    fireEvent.keyDown(window, { key: "2" });
    expect(props.onLabelChange).toHaveBeenCalledWith("bad");
  });

  it("pressing s triggers skip", () => {
    const props = renderView();
    fireEvent.keyDown(window, { key: "s" });
    expect(props.onSkip).toHaveBeenCalledTimes(1);
  });

  it("pressing Enter triggers submit", () => {
    const props = renderView();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("suppresses shortcuts while focus is inside the notes textarea", () => {
    const props = renderView();
    const notes = screen.getByPlaceholderText(/optional notes/i);
    notes.focus();
    fireEvent.keyDown(notes, { key: "2" });
    fireEvent.keyDown(notes, { key: "s" });
    fireEvent.keyDown(notes, { key: "Enter" });
    expect(props.onLabelChange).not.toHaveBeenCalled();
    expect(props.onSkip).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("links back to the source trace with the span id", () => {
    renderView();
    const link = screen.getByRole("link", { name: /view source trace/i });
    expect(link).toHaveAttribute("href", "/traces?id=trace-123&span=span-456");
  });

  it("renders the raw prompt when present, and falls back to the payload JSON otherwise", () => {
    renderView({ item: baseItem({ prompt: null }) });
    expect(screen.getByText(/"foo": "bar"/)).toBeInTheDocument();
  });
});
