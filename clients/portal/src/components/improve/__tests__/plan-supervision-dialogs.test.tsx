import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MergePlanDialog } from "../merge-plan-dialog";
import { RevertPlanDialog } from "../revert-plan-dialog";

describe("plan supervision dialogs", () => {
  it("MergePlanDialog confirms merge", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <MergePlanDialog
        planTitle="Fix timeout"
        prUrl="https://github.com/o/r/pull/1"
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Merge PR" })).toBeInTheDocument();
    expect(screen.getByText(/post-merge regression verify/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Merge PR" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("RevertPlanDialog confirms revert", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <RevertPlanDialog
        planTitle="Fix timeout"
        prUrl="https://github.com/o/r/pull/1"
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Revert merged fix" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/inverse-diff revert plan/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revert" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
