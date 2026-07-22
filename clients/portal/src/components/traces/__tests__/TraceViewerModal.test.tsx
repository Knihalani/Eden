import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TraceViewerModal } from "../TraceViewerModal";

describe("TraceViewerModal", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders near-fullscreen dialog with aria-modal when open", () => {
    render(
      <TraceViewerModal open onClose={vi.fn()} traceId="tr_abc123" title="Agent X" outcome="success">
        <p>body content</p>
      </TraceViewerModal>,
    );
    const modal = screen.getByTestId("trace-viewer-modal");
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("body content")).toBeInTheDocument();
    expect(screen.getByTestId("trace-viewer-close")).toBeInTheDocument();
    expect(screen.getByTestId("trace-viewer-backdrop")).toBeInTheDocument();
  });

  it("returns nothing interactive when closed", () => {
    render(
      <TraceViewerModal open={false} onClose={vi.fn()} traceId="tr_x">
        hidden
      </TraceViewerModal>,
    );
    expect(screen.queryByTestId("trace-viewer-modal")).not.toBeInTheDocument();
  });

  it("calls onClose from Close control", () => {
    const onClose = vi.fn();
    render(
      <TraceViewerModal open onClose={onClose} traceId="tr_close">
        body
      </TraceViewerModal>,
    );
    fireEvent.click(screen.getByTestId("trace-viewer-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on Escape via Dialog", () => {
    const onClose = vi.fn();
    render(
      <TraceViewerModal open onClose={onClose} traceId="tr_esc">
        body
      </TraceViewerModal>,
    );
    fireEvent.keyDown(screen.getByTestId("trace-viewer-modal"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("wires j/k to onNext/onPrev when provided", () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    render(
      <TraceViewerModal
        open
        onClose={vi.fn()}
        traceId="tr_nav"
        onNext={onNext}
        onPrev={onPrev}
      >
        body
      </TraceViewerModal>,
    );
    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(document, { key: "k" });
    expect(onNext).toHaveBeenCalled();
    expect(onPrev).toHaveBeenCalled();
  });
});
