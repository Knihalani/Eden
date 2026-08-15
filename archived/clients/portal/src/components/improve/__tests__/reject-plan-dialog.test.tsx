import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RejectPlanDialog } from "../reject-plan-dialog";

describe("RejectPlanDialog", () => {
  it("defaults to the wontfix category and confirms a plain reason", () => {
    const onConfirm = vi.fn();
    render(
      <RejectPlanDialog
        planTitle="Patch: fix retry loop"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onConfirm).toHaveBeenCalledWith("wontfix");
  });

  it("appends free-text detail to the selected category", () => {
    const onConfirm = vi.fn();
    render(
      <RejectPlanDialog
        planTitle="Patch: fix retry loop"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /Already fixed/ }));
    fireEvent.change(screen.getByPlaceholderText(/Anything else/), {
      target: { value: "Fixed by ops directly in prod." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onConfirm).toHaveBeenCalledWith(
      "user_fixed: Fixed by ops directly in prod.",
    );
  });

  it("disables actions while busy and calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <RejectPlanDialog
        planTitle="Patch: fix retry loop"
        busy
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Rejecting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    render(
      <RejectPlanDialog
        planTitle="Patch: fix retry loop"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
