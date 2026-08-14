// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const pushToast = vi.fn();
vi.mock("@/lab/lab-toast", () => ({
  useLabToast: () => ({ pushToast }),
}));

import { FirstEventWaitAction } from "./first-event-wait";

describe("FirstEventWaitAction (R037)", () => {
  it("toasts when check finds no events", async () => {
    pushToast.mockClear();
    render(<FirstEventWaitAction onCheck={async () => []} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for events" }));
    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "No events yet" }),
      );
    });
  });

  it("toasts a count when events exist", async () => {
    pushToast.mockClear();
    render(<FirstEventWaitAction onCheck={async () => [{ id: "1" }, { id: "2" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for events" }));
    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "2 events found" }),
      );
    });
  });
});
