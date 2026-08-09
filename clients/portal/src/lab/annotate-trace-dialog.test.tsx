// @vitest-environment jsdom
/**
 * FEAT-115 — AnnotateTraceDialog calls api.annotateTrace and closes on success.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const annotateTrace = vi.fn();
const pushToast = vi.fn();

vi.mock("@/lib/api/resources", () => ({
  api: {
    annotateTrace: (...args: unknown[]) => annotateTrace(...args),
  },
}));

vi.mock("@/lab/lab-toast", () => ({
  useLabToast: () => ({ pushToast }),
}));

import { AnnotateTraceDialog } from "./annotate-trace-dialog";

describe("AnnotateTraceDialog FEAT-115", () => {
  beforeEach(() => {
    annotateTrace.mockReset();
    pushToast.mockReset();
  });

  it("renders when open and closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <AnnotateTraceDialog
        open
        onClose={onClose}
        orgId="org-1"
        traceId="tr_abc"
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Annotate" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("submits score + category via api.annotateTrace", async () => {
    annotateTrace.mockResolvedValueOnce({
      item_id: "item-1",
      annotation_id: "ann-1",
      label: { score: 7, category: "quality" },
      confidence: 1,
      created_at: "2026-01-01T00:00:00Z",
    });
    const onClose = vi.fn();

    render(
      <AnnotateTraceDialog
        open
        onClose={onClose}
        orgId="org-1"
        traceId="tr_abc"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("What stood out?"), {
      target: { value: "Looks good" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));

    await waitFor(() => {
      expect(annotateTrace).toHaveBeenCalledWith(
        "org-1",
        "tr_abc",
        expect.objectContaining({
          score: 7,
          category: "quality",
          comment: "Looks good",
        }),
      );
    });
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Annotation saved", tone: "ok" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an error when annotateTrace fails", async () => {
    annotateTrace.mockRejectedValueOnce(new Error("quota exceeded"));
    const onClose = vi.fn();

    render(
      <AnnotateTraceDialog
        open
        onClose={onClose}
        orgId="org-1"
        traceId="tr_abc"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("quota exceeded");
    expect(onClose).not.toHaveBeenCalled();
  });
});
