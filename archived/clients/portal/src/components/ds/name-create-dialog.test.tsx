// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NameCreateDialog } from "./name-create-dialog";

describe("NameCreateDialog (R022)", () => {
  it("requires a name and allows cancel", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <NameCreateDialog
        open
        title="New dataset"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms a trimmed name", () => {
    const onConfirm = vi.fn();
    render(
      <NameCreateDialog
        open
        title="New dataset"
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Nightly eval  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onConfirm).toHaveBeenCalledWith("Nightly eval");
  });
});
