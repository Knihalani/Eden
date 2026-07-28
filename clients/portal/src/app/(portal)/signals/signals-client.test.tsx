import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LabToastProvider } from "@/lab/lab-toast";
import { SignalJobsProvider } from "@/lab/signal-jobs-context";
import { CreateSignalDialog } from "./signals-client";

// Regression coverage for: CreateSignalDialog (role="dialog" aria-modal)
// only handled Escape-to-close — Tab/Shift+Tab could move focus onto page
// content behind the backdrop, and focus was never returned to the
// triggering "Create signal" button on close.

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// jsdom never computes layout, so `offsetParent` is hardcoded to `null` for
// every element — the dialog's own visibility filter (`el.offsetParent !==
// null || el === document.activeElement`, mirroring the pattern already used
// by ProductTour.tsx) would otherwise collapse to a single node regardless
// of how many controls are actually on screen. Stub it locally (scoped to
// this file's isolated jsdom instance) so the trap can be exercised the way
// a real browser would run it.
let restoreOffsetParent: (() => void) | undefined;
beforeAll(() => {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetParent",
  );
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
  restoreOffsetParent = () => {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, "offsetParent", descriptor);
    }
  };
});
afterAll(() => {
  restoreOffsetParent?.();
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <LabToastProvider>
      <SignalJobsProvider>
        <button type="button" onClick={() => setOpen(true)}>
          Create signal
        </button>
        <CreateSignalDialog
          open={open}
          onClose={() => setOpen(false)}
          defaultAgentId={null}
        />
      </SignalJobsProvider>
    </LabToastProvider>
  );
}

function openDialog() {
  const trigger = screen.getByRole("button", { name: "Create signal" });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe("CreateSignalDialog focus trap", () => {
  it("wraps Tab from the last focusable element back to the first", () => {
    render(<Harness />);
    openDialog();

    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab from the first focusable element back to the last", () => {
    render(<Harness />);
    openDialog();

    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    first.focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("pulls focus back inside the dialog if it somehow lands outside it", () => {
    render(<Harness />);
    const trigger = openDialog();

    // Simulate focus escaping to page content behind the backdrop.
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    const first = focusable[0];

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });
});

describe("CreateSignalDialog focus restore", () => {
  it("returns focus to the trigger button when closed via Cancel", async () => {
    render(<Harness />);
    const trigger = openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the trigger button when closed via the X button", async () => {
    render(<Harness />);
    const trigger = openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the trigger button when closed via Escape", async () => {
    render(<Harness />);
    const trigger = openDialog();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the trigger button when closed via the backdrop click", async () => {
    render(<Harness />);
    const trigger = openDialog();

    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(trigger);
  });
});
