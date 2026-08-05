import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { dynamicWithRetry } from "@/lib/dynamic-with-retry";

function Panel({ label }: { label: string }) {
  return <div>Loaded: {label}</div>;
}

describe("dynamicWithRetry", () => {
  it("renders the loaded component on a successful import", async () => {
    const importFn = vi.fn(() =>
      Promise.resolve({ default: Panel }),
    );
    const Comp = dynamicWithRetry(importFn, {
      loading: () => <div>Loading…</div>,
    });

    render(<Comp label="ok" />);

    expect(await screen.findByText("Loaded: ok")).toBeTruthy();
    expect(importFn).toHaveBeenCalledTimes(1);
  });

  it("shows a retry affordance on a rejected import instead of throwing to a parent boundary", async () => {
    const importFn = vi.fn(() =>
      Promise.reject(new Error("Chunk load failed")),
    );
    const Comp = dynamicWithRetry(importFn);

    render(<Comp label="broken" />);

    expect(await screen.findByText("Chunk load failed")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Retry" }),
    ).toBeTruthy();
    expect(importFn).toHaveBeenCalledTimes(1);
  });

  it("re-invokes a fresh import() on retry instead of replaying the cached rejection", async () => {
    const importFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Chunk load failed"))
      .mockResolvedValueOnce({ default: Panel });

    const Comp = dynamicWithRetry(importFn);

    render(<Comp label="second-try" />);

    const retryButton = await screen.findByRole("button", {
      name: "Retry",
    });
    fireEvent.click(retryButton);

    await waitFor(() =>
      expect(screen.getByText("Loaded: second-try")).toBeTruthy(),
    );
    expect(importFn).toHaveBeenCalledTimes(2);
  });

  it("fails an attempt that exceeds the configured timeout", async () => {
    const importFn = vi.fn(
      () => new Promise<{ default: typeof Panel }>(() => {}),
    );
    const Comp = dynamicWithRetry(importFn, { timeoutMs: 10 });

    render(<Comp label="slow" />);

    expect(await screen.findByText(/timed out/i)).toBeTruthy();
  });
});
