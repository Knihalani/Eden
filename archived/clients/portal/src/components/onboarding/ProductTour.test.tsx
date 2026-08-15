import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProductTour, pageMatchesCurrentRoute } from "./ProductTour";
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

/**
 * The window where `ready` is false is not an edge case: every navigating step
 * passes through it, and on a slow route/chunk load it can last up to the
 * settle effect's 2500ms budget. The card — and with it #eden-tour-title and
 * #eden-tour-body — is unmounted for that whole window, so the overlay must
 * still be a named dialog and must still look like a tour rather than a hung
 * black screen.
 */
describe("ProductTour settle window", () => {
  afterEach(() => {
    mountedTargets.splice(0).forEach((el) => el.remove());
  });

  it("stays a named dialog and shows a loading affordance while settling", async () => {
    mountTourTarget("home");

    render(
      <ProductTour
        open
        stepIndex={1}
        onStepChange={vi.fn()}
        onSkip={vi.fn()}
        onFinish={vi.fn()}
      />,
    );

    await waitFor(() => expect(hasSpotlightMask()).toBe(true), {
      timeout: SETTLE_WAITFOR_TIMEOUT_MS,
    });

    // Settled: the real heading labels the dialog.
    const settled = screen.getByRole("dialog");
    expect(settled).toHaveAttribute("aria-labelledby", "eden-tour-title");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // Navigating to a different-href step drops `ready` synchronously.
    fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    const settling = screen.getByRole("dialog");
    // Regression: this pointed at #eden-tour-title even while that node was
    // unmounted, leaving an aria-modal dialog with no accessible name.
    expect(settling).not.toHaveAttribute("aria-labelledby");
    expect(settling).toHaveAttribute("aria-label", "Product tour");
    // Regression: the scrim rendered alone, with nothing to distinguish a
    // loading tour from a frozen page.
    expect(screen.getByRole("status")).toHaveTextContent("Loading tour step…");
  }, SETTLE_WAITFOR_TIMEOUT_MS + 5000);
});

/**
 * ``pageMatchesCurrentRoute`` gates the settle fast-path and the step
 * navigation — the card may only settle on a step whose page is actually
 * current, and both call sites share the helper so they can never drift
 * apart (e.g. a mode-normalization change silently desyncing the
 * narrow-screen fast-path from real navigation).
 */
describe("pageMatchesCurrentRoute", () => {
  it("matches by pathname and settings mode", () => {
    expect(
      pageMatchesCurrentRoute("/settings?mode=keys", "/settings", "mode=keys"),
    ).toBe(true);
    expect(
      pageMatchesCurrentRoute("/settings?mode=keys", "/settings", ""),
    ).toBe(false);
    expect(pageMatchesCurrentRoute("/traces", "/traces", "")).toBe(true);
    expect(pageMatchesCurrentRoute("/home", "/traces", "")).toBe(false);
  });

  it("normalizes legacy modes and matches nested paths", () => {
    // Legacy tab=api-keys is equivalent to mode=keys.
    expect(
      pageMatchesCurrentRoute(
        "/settings?tab=api-keys",
        "/settings",
        "tab=api-keys",
      ),
    ).toBe(true);
    // mode=api-keys normalizes to keys on both sides.
    expect(
      pageMatchesCurrentRoute(
        "/settings?mode=api-keys",
        "/settings",
        "mode=api-keys",
      ),
    ).toBe(true);
    // Steps on /home match any nested route under it.
    expect(pageMatchesCurrentRoute("/home", "/home/issues", "")).toBe(true);
  });

  it("never matches when the path is unrelated", () => {
    expect(pageMatchesCurrentRoute("/home", "/settings", "mode=keys")).toBe(
      false,
    );
    expect(pageMatchesCurrentRoute("/traces", "/settings", "")).toBe(false);
  });
});

/**
 * Scrim clicks must never dismiss the tour — a stray outside click used to
 * persist ``status: "skipped"`` and pause the tour with no way back in (the
 * original "tour starts paused" bug). Only the explicit exits (X, Skip,
 * Esc, Done) may close it; the one deliberate scrim interaction is the
 * punch-through that clicks the spotlighted element inside the hole.
 */
describe("ProductTour scrim clicks", () => {
  afterEach(() => {
    mountedTargets.splice(0).forEach((el) => el.remove());
  });

  it("does not skip the tour on a scrim click on the welcome step", async () => {
    // Welcome (index 0) has no spotlight hole — the whole scrim is a click
    // surface, and none of it may dismiss the tour.
    const onSkip = vi.fn();
    render(
      <ProductTour
        open
        stepIndex={0}
        onStepChange={vi.fn()}
        onSkip={onSkip}
        onFinish={vi.fn()}
      />,
    );

    await screen.findByText("Welcome to Eden");
    fireEvent.click(screen.getByTestId("tour-scrim"));

    expect(onSkip).not.toHaveBeenCalled();
    expect(screen.getByText("Welcome to Eden")).toBeInTheDocument();
  });

  it("does not skip on a scrim click that misses the spotlight hole", async () => {
    mountTourTarget("home");

    const onSkip = vi.fn();
    render(
      <ProductTour
        open
        stepIndex={1}
        onStepChange={vi.fn()}
        onSkip={onSkip}
        onFinish={vi.fn()}
      />,
    );

    await waitFor(() => expect(hasSpotlightMask()).toBe(true), {
      timeout: SETTLE_WAITFOR_TIMEOUT_MS,
    });

    // The fake target sits at ~100,100 (60x30 + PAD=10). A click far from
    // the hole must be a no-op, not a dismissal.
    fireEvent.click(screen.getByTestId("tour-scrim"), {
      clientX: 700,
      clientY: 700,
    });

    expect(onSkip).not.toHaveBeenCalled();
  });
});
