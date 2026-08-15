// @vitest-environment jsdom
/**
 * Wave 14 — route-change chrome. The portal scrolls a custom `<main>`
 * container, so Next's built-in scroll restoration never fires; the hook
 * scrolls main to top and moves focus to it on pathname change (skipping
 * the first render and any moment a modal dialog owns the screen).
 */
import { render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useRouteScrollReset } from "@/hooks/use-route-scroll-reset";

let mockPathname = "/traces";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

function Harness() {
  const ref = useRef<HTMLElement | null>(null);
  useRouteScrollReset(ref);
  return (
    <main
      data-testid="main"
      ref={ref}
      tabIndex={-1}
    />
  );
}

describe("useRouteScrollReset", () => {
  it("scrolls main to top and focuses it on pathname change", () => {
    const { rerender, container } = render(<Harness />);
    const main = container.querySelector<HTMLElement>("[data-testid=main]")!;
    const scrollTo = vi.fn();
    const focus = vi.fn();
    main.scrollTo = scrollTo;
    main.focus = focus;

    // First render — hook skips it.
    expect(scrollTo).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    // Pathname change on the same mounted instance → scroll + focus.
    mockPathname = "/issues";
    rerender(<Harness />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0 });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does not scroll or focus while a modal dialog is open", () => {
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);

    const { rerender, container } = render(<Harness />);
    const main = container.querySelector<HTMLElement>("[data-testid=main]")!;
    const scrollTo = vi.fn();
    const focus = vi.fn();
    main.scrollTo = scrollTo;
    main.focus = focus;

    mockPathname = "/home";
    rerender(<Harness />);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    document.body.removeChild(modal);
  });

  it("keeps the current scroll position for search-param-only changes", () => {
    const { rerender, container } = render(<Harness />);
    const main = container.querySelector<HTMLElement>("[data-testid=main]")!;
    const scrollTo = vi.fn();
    const focus = vi.fn();
    main.scrollTo = scrollTo;
    main.focus = focus;

    // Same pathname (params changed via `?id=`) → no scroll/focus.
    rerender(<Harness />);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});
