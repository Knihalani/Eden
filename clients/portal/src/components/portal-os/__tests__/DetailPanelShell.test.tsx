import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DetailPanelShell } from "../DetailPanelShell";
import {
  clearTraceDetailParams,
  MASTER_DETAIL_QUERY_KEYS,
  readMasterDetailParam,
  writeMasterDetailParam,
} from "../CoreResourcePage";

describe("DetailPanelShell (UX-P0-07)", () => {
  it("renders dialog chrome with xl split / drawer classes when open", () => {
    render(
      <DetailPanelShell open onClose={vi.fn()} title="Trace abc">
        <p>body</p>
      </DetailPanelShell>,
    );
    const panel = screen.getByTestId("detail-panel-shell");
    expect(panel).toHaveAttribute("role", "dialog");
    expect(panel.className).toMatch(/xl:static/);
    expect(screen.getByTestId("detail-panel-backdrop").className).toMatch(/xl:hidden/);
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("returns null when closed", () => {
    const { container } = render(
      <DetailPanelShell open={false} onClose={vi.fn()} title="x">
        hidden
      </DetailPanelShell>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(
      <DetailPanelShell open onClose={onClose} title="t">
        content
      </DetailPanelShell>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("uses ui/tabs for mode tabs (no hand-rolled role=tablist)", () => {
    render(
      <DetailPanelShell
        open
        onClose={vi.fn()}
        title="t"
        tabs={[
          { id: "transcript", label: "Transcript" },
          { id: "tree", label: "Tree" },
        ]}
        activeTab="transcript"
        onTabChange={vi.fn()}
      >
        body
      </DetailPanelShell>,
    );
    expect(screen.getByRole("tab", { name: "Transcript" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Detail panel sections" })).toBeInTheDocument();
  });
});

describe("master–detail URL helpers", () => {
  it("documents canonical keys and reads aliases", () => {
    expect(MASTER_DETAIL_QUERY_KEYS.traceId[0]).toBe("traceId");
    expect(MASTER_DETAIL_QUERY_KEYS.viewId).toContain("savedView");

    const params = new URLSearchParams("trace_id=abc&savedView=v1");
    expect(readMasterDetailParam(params, "traceId")).toBe("abc");
    expect(readMasterDetailParam(params, "viewId")).toBe("v1");
  });

  it("writes canonical and strips aliases", () => {
    const params = new URLSearchParams("trace_id=old&trace=x");
    writeMasterDetailParam(params, "traceId", "new");
    expect(params.get("traceId")).toBe("new");
    expect(params.get("trace_id")).toBeNull();
    expect(params.get("trace")).toBeNull();

    clearTraceDetailParams(params);
    expect(params.get("traceId")).toBeNull();
    expect(params.get("spanId")).toBeNull();
  });
});
