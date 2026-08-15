import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnnotateView, formatAnnotateSessionStats, formatItemDisagreementHint } from "@/lab/labeling/annotate-view";
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

  it("Shift+3 sets confidence to 0.6", () => {
    const props = renderView();
    fireEvent.keyDown(window, { key: "3", code: "Digit3", shiftKey: true });
    expect(props.onConfidenceChange).toHaveBeenCalledWith(0.6);
  });

  it("Shift+5 sets confidence to 1.0", () => {
    const props = renderView();
    fireEvent.keyDown(window, { key: "5", code: "Digit5", shiftKey: true });
    expect(props.onConfidenceChange).toHaveBeenCalledWith(1.0);
  });

  it("Shift+2 does not select a label option", () => {
    const props = renderView();
    fireEvent.keyDown(window, { key: "2", code: "Digit2", shiftKey: true });
    expect(props.onLabelChange).not.toHaveBeenCalled();
    expect(props.onConfidenceChange).toHaveBeenCalledWith(0.4);
  });

  it("Shift+1 works when key is '!' (US keyboard layout)", () => {
    const props = renderView();
    fireEvent.keyDown(window, { key: "!", code: "Digit1", shiftKey: true });
    expect(props.onConfidenceChange).toHaveBeenCalledWith(0.2);
    expect(props.onLabelChange).not.toHaveBeenCalled();
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

  it("pressing u triggers undo when canUndo is set", () => {
    const onUndo = vi.fn();
    renderView({ onUndo, canUndo: true });
    fireEvent.keyDown(window, { key: "u" });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("pressing Backspace triggers undo when canUndo is set", () => {
    const onUndo = vi.fn();
    renderView({ onUndo, canUndo: true });
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("does not trigger undo when canUndo is false", () => {
    const onUndo = vi.fn();
    renderView({ onUndo, canUndo: false });
    fireEvent.keyDown(window, { key: "u" });
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("suppresses shortcuts while focus is inside the notes textarea", () => {
    const props = renderView();
    const notes = screen.getByPlaceholderText(/optional notes/i);
    notes.focus();
    fireEvent.keyDown(notes, { key: "2" });
    fireEvent.keyDown(notes, { key: "3", code: "Digit3", shiftKey: true });
    fireEvent.keyDown(notes, { key: "s" });
    fireEvent.keyDown(notes, { key: "Enter" });
    fireEvent.keyDown(notes, { key: "u" });
    expect(props.onLabelChange).not.toHaveBeenCalled();
    expect(props.onConfidenceChange).not.toHaveBeenCalled();
    expect(props.onSkip).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("shows per-item disagreement without revealing other labels", () => {
    renderView({ annotationsCount: 2, agreementSoFar: 0.25 });
    expect(screen.getByText("2 annotations · agreement 0.25 so far")).toBeInTheDocument();
  });

  it("shows annotation count only when agreement is not yet computable", () => {
    renderView({ annotationsCount: 1, agreementSoFar: null });
    expect(screen.getByText("1 annotation so far")).toBeInTheDocument();
    expect(screen.queryByText(/agreement/)).not.toBeInTheDocument();
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

describe("AnnotateView session progress", () => {
  it("shows zero session count without avg", () => {
    renderView({ sessionLabeled: 0, sessionAvgSeconds: 0 });
    expect(screen.getByText("0 labeled this session")).toBeInTheDocument();
    expect(screen.queryByText(/avg/)).not.toBeInTheDocument();
  });

  it("shows labeled count and avg seconds when session has progress", () => {
    renderView({ sessionLabeled: 3, sessionAvgSeconds: 12 });
    expect(screen.getByText("3 labeled this session · avg 12s/item")).toBeInTheDocument();
  });

  it("formats fractional avg seconds to one decimal", () => {
    renderView({ sessionLabeled: 2, sessionAvgSeconds: 12.5 });
    expect(screen.getByText("2 labeled this session · avg 12.5s/item")).toBeInTheDocument();
  });
});

describe("formatItemDisagreementHint", () => {
  it("returns null when there are no annotations", () => {
    expect(formatItemDisagreementHint(0, null)).toBeNull();
  });

  it("formats agreement when present", () => {
    expect(formatItemDisagreementHint(3, 0.67)).toBe(
      "3 annotations · agreement 0.67 so far",
    );
  });
});
