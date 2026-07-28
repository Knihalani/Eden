import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProductTour } from "./ProductTour";
import { PRODUCT_TOUR_STEPS } from "@/lib/product-tour";

// jsdom does not implement requestAnimationFrame; ProductTour's settle
// effect (double-rAF after scrollIntoView) needs it to ever resolve.
beforeAll(() => {
  if (typeof window.requestAnimationFrame !== "function") {
    window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      window.setTimeout(() => cb(performance.now()), 0)) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) =>
      window.clearTimeout(id)) as typeof window.cancelAnimationFrame;
  }
});

const pushMock = vi.fn();
// Real Next.js returns a stable router object across renders. A fresh
// object here would change identity on every render, which — since
// `router` sits in the "step href" effect's dependency array — would
// re-fire that effect on every re-render and mask real bugs (it would
// keep resetting `ready` back to true right after our own updates).
const routerMock = { push: pushMock };

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(""),
}));

const mountedTargets: HTMLElement[] = [];

/** Mount a fake sidebar target (outside React) so `measureTarget` finds it. */
function mountTourTarget(targetId: string) {
  const el = document.createElement("div");
  el.setAttribute("data-tour-id", targetId);
  el.getBoundingClientRect = () =>
    ({
      top: 100,
      left: 100,
      width: 60,
      height: 30,
      bottom: 130,
      right: 160,
      x: 100,
      y: 100,
      toJSON() {
        return {};
      },
    }) as DOMRect;
  document.body.appendChild(el);
  mountedTargets.push(el);
  return el;
}

/** Spotlight is rendered as an SVG <mask> around the measured hole. */
function hasSpotlightMask() {
  return document.querySelector("svg mask") !== null;
}

// ProductTour's settle effect (see ProductTour.tsx ~L236-291) resolves via a
// setTimeout(40ms) -> tick() -> scrollIntoView -> double-rAF chain, where rAF
// is polyfilled above as setTimeout(cb, 0). That's several real macrotasks
// queued back-to-back; under CPU contention in CI/parallel test runs those
// callbacks can be delayed well past testing-library's 1000ms default
// waitFor timeout even though the chain itself is not hung. Give the
// baseline "spotlight appeared" assertion a generous budget so transient
// scheduler contention can't produce a false failure — this does not change
// what is asserted, only how long we're willing to wait for it.
const SETTLE_WAITFOR_TIMEOUT_MS = 15000;

describe("ProductTour navigation resets", () => {
  beforeEach(() => {
    pushMock.mockClear();
  });

  afterEach(() => {
    // RTL's own automatic cleanup (registered via its afterEach) unmounts
    // rendered trees; only tear down the out-of-band target nodes we
    // appended directly, so the two cleanups don't fight over the DOM.
    mountedTargets.splice(0).forEach((el) => el.remove());
  });

  it("goNext (button) clears both ready and hole when moving to a different-href step", async () => {
    // Home (index 1, href "/home") -> Traces (index 2, href "/traces").
    expect(PRODUCT_TOUR_STEPS[2]?.href).not.toBe(PRODUCT_TOUR_STEPS[1]?.href);

    mountTourTarget("home");

    const onStepChange = vi.fn();
    render(
      <ProductTour
        open
        stepIndex={1}
        onStepChange={onStepChange}
        onSkip={vi.fn()}
        onFinish={vi.fn()}
      />,
    );

    // Let the settle effect measure the "home" target and show the card
    // + spotlight — the "before navigating" baseline state.
    await waitFor(() => expect(hasSpotlightMask()).toBe(true), {
      timeout: SETTLE_WAITFOR_TIMEOUT_MS,
    });
    expect(screen.getByText("Home")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    // goNext is the known-good reference: it clears both `ready` and
    // `hole` synchronously, before onStepChange is even called.
    expect(hasSpotlightMask()).toBe(false);
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
    expect(onStepChange).toHaveBeenCalledWith(2);
  }, SETTLE_WAITFOR_TIMEOUT_MS + 5000);

  it("ArrowRight clears the spotlight hole (not just the card) into a different-href step", async () => {
    // Home (index 1, href "/home") -> Traces (index 2, href "/traces").
    expect(PRODUCT_TOUR_STEPS[2]?.href).not.toBe(PRODUCT_TOUR_STEPS[1]?.href);

    mountTourTarget("home");

    const onStepChange = vi.fn();
    render(
      <ProductTour
        open
        stepIndex={1}
        onStepChange={onStepChange}
        onSkip={vi.fn()}
        onFinish={vi.fn()}
      />,
    );

    await waitFor(() => expect(hasSpotlightMask()).toBe(true), {
      timeout: SETTLE_WAITFOR_TIMEOUT_MS,
    });
    expect(screen.getByText("Home")).toBeInTheDocument();

    // Keyboard-driven navigation must reset the spotlight the same way
    // goNext does. Regression: previously only `ready` was cleared here,
    // leaving a stale spotlight rect (from the *previous* step's target)
    // rendered until the next settle cycle caught up.
    fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(hasSpotlightMask()).toBe(false);
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
    expect(onStepChange).toHaveBeenCalledWith(2);
  }, SETTLE_WAITFOR_TIMEOUT_MS + 5000);

  it("ArrowLeft clears the spotlight hole (not just the card) into a different-href step", async () => {
    // Traces (index 2, href "/traces") -> Home (index 1, href "/home").
    expect(PRODUCT_TOUR_STEPS[1]?.href).not.toBe(PRODUCT_TOUR_STEPS[2]?.href);

    mountTourTarget("traces");

    const onStepChange = vi.fn();
    render(
      <ProductTour
        open
        stepIndex={2}
        onStepChange={onStepChange}
        onSkip={vi.fn()}
        onFinish={vi.fn()}
      />,
    );

    await waitFor(() => expect(hasSpotlightMask()).toBe(true), {
      timeout: SETTLE_WAITFOR_TIMEOUT_MS,
    });
    expect(screen.getByText("Traces")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowLeft" });

    expect(hasSpotlightMask()).toBe(false);
    expect(screen.queryByText("Traces")).not.toBeInTheDocument();
    expect(onStepChange).toHaveBeenCalledWith(1);
  }, SETTLE_WAITFOR_TIMEOUT_MS + 5000);
});
