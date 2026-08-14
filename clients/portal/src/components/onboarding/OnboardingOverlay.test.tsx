import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Completion registration for the product tour.
 *
 * `ProductTour.test.tsx` covers the spotlight/navigation UI. This file covers
 * the other half — the orchestrator's *exit* contract, which had no coverage
 * at all despite being the thing that decides whether a user ever sees the
 * tour again:
 *
 *   - Finishing (Done on the finish step) must persist `status: "done"`.
 *   - Skipping (Esc / X / Skip) must persist `status: "skipped"` (a
 *     resumable pause, not a finish).
 *   - Only "done" retires the resume banner; "skipped" keeps it as the
 *     resume affordance.
 *   - Any started-but-unfinished tour ("active" or paused "skipped")
 *     auto-resumes on the next portal entry (once per session) so
 *     onboarding opens by default.
 *   - Neither exit may let the effect loop re-open the tour afterwards.
 *
 * The seam is deliberately at the ProductTour boundary: ProductTour is stubbed
 * so these tests assert what OnboardingOverlay persists in response to the
 * callbacks, without re-testing spotlight measurement (which needs layout jsdom
 * does not have).
 */

const clerk = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  update: vi.fn(),
}));

const org = vi.hoisted(() => ({
  currentOrg: { id: "org_1", name: "Acme" } as unknown,
  loading: false,
  orgSyncing: false,
}));

const nav = vi.hoisted(() => ({
  pathname: "/home",
  search: "onboarding=1",
  push: vi.fn(),
  replace: vi.fn(),
}));

const toasts = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    user: { id: "user_1", unsafeMetadata: clerk.metadata, update: clerk.update },
    isLoaded: true,
  }),
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({
    currentOrg: org.currentOrg,
    loading: org.loading,
    orgSyncing: org.orgSyncing,
  }),
}));

// Stable router identity across renders — a fresh object each call would
// re-fire every effect that lists `router` as a dependency.
const routerMock = { push: nav.push, replace: nav.replace };
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/lab/lab-toast", () => ({
  useLabToast: () => ({ pushToast: toasts.push }),
}));

// Minimal stand-in for the spotlight overlay: exposes exactly the three
// callbacks the orchestrator wires up, so each exit path can be driven
// directly without needing layout.
vi.mock("@/components/onboarding/ProductTour", () => ({
  ProductTour: ({
    open,
    stepIndex,
    onStepChange,
    onSkip,
    onFinish,
  }: {
    open: boolean;
    stepIndex: number;
    onStepChange: (i: number) => void;
    onSkip: () => void;
    onFinish: () => void;
  }) =>
    open ? (
      <div data-testid="tour" data-step={stepIndex}>
        <button onClick={() => onStepChange(stepIndex + 1)}>next</button>
        <button onClick={onSkip}>skip</button>
        <button onClick={onFinish}>done</button>
      </div>
    ) : null,
}));

import { OnboardingOverlay } from "./OnboardingOverlay";
import { OnboardingBanner } from "./OnboardingBanner";
import { PRODUCT_TOUR_TOTAL } from "@/lib/product-tour";
import { EDEN_TOUR_META_KEY } from "@/lib/tour-progress";

/** The tour payload of the most recent Clerk write. */
function lastWrite() {
  const calls = clerk.update.mock.calls;
  if (calls.length === 0) return null;
  return calls[calls.length - 1][0].unsafeMetadata[EDEN_TOUR_META_KEY] as {
    status: string;
    stepIndex: number;
  };
}

beforeEach(() => {
  clerk.metadata = {};
  clerk.update.mockReset();
  // Writes land in the mocked metadata so a re-render observes the new
  // status, exactly as Clerk's resource cache would surface it.
  clerk.update.mockImplementation(
    async (patch: { unsafeMetadata: Record<string, unknown> }) => {
      clerk.metadata = patch.unsafeMetadata;
    },
  );
  org.currentOrg = { id: "org_1", name: "Acme" };
  org.loading = false;
  org.orgSyncing = false;
  nav.pathname = "/home";
  nav.search = "onboarding=1";
  nav.push.mockReset();
  nav.replace.mockReset();
  toasts.push.mockReset();
});

describe("tour completion registers", () => {
  it("persists status 'done' pinned to the final step when Done is clicked", async () => {
    const user = userEvent.setup();
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "active",
        stepIndex: PRODUCT_TOUR_TOTAL - 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    render(<OnboardingOverlay />);
    const tour = await screen.findByTestId("tour");
    expect(tour.dataset.step).toBe(String(PRODUCT_TOUR_TOTAL - 1));

    await user.click(screen.getByText("done"));

    await waitFor(() => expect(clerk.update).toHaveBeenCalled());
    expect(lastWrite()).toMatchObject({
      status: "done",
      stepIndex: PRODUCT_TOUR_TOTAL - 1,
    });
  });

  it("closes on finish and does not let the effect loop re-open it", async () => {
    const user = userEvent.setup();
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "active",
        stepIndex: PRODUCT_TOUR_TOTAL - 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    const view = render(<OnboardingOverlay />);
    await screen.findByTestId("tour");

    await user.click(screen.getByText("done"));

    await waitFor(() =>
      expect(screen.queryByTestId("tour")).not.toBeInTheDocument(),
    );

    // The URL flag drains after the optimistic close; re-render on the
    // cleared query and confirm the tour stays shut.
    nav.search = "";
    view.rerender(<OnboardingOverlay />);
    await waitFor(() => expect(clerk.update).toHaveBeenCalled());
    expect(screen.queryByTestId("tour")).not.toBeInTheDocument();
  });

  it("confirms completion to the user with a success toast", async () => {
    const user = userEvent.setup();
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "active",
        stepIndex: PRODUCT_TOUR_TOTAL - 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    render(<OnboardingOverlay />);
    await screen.findByTestId("tour");
    await user.click(screen.getByText("done"));

    await waitFor(() => expect(toasts.push).toHaveBeenCalled());
    expect(toasts.push.mock.calls[0][0]).toMatchObject({ tone: "ok" });
  });

  it("recovers a transient write failure so completion is not lost", async () => {
    const user = userEvent.setup();
    // Fail once, then succeed — the shape of a network blip. Without a retry
    // this silently leaves a finished user on "active", nagged to continue a
    // tour they completed.
    clerk.update
      .mockRejectedValueOnce(new Error("transient"))
      .mockImplementation(
        async (patch: { unsafeMetadata: Record<string, unknown> }) => {
          clerk.metadata = patch.unsafeMetadata;
        },
      );
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "active",
        stepIndex: PRODUCT_TOUR_TOTAL - 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    render(<OnboardingOverlay />);
    await screen.findByTestId("tour");
    await user.click(screen.getByText("done"));

    await waitFor(() => expect(toasts.push).toHaveBeenCalled());
    expect(clerk.update).toHaveBeenCalledTimes(2);
    expect(lastWrite()).toMatchObject({ status: "done" });
    // The user is told it worked, because it did.
    expect(toasts.push.mock.calls[0][0]).toMatchObject({ tone: "ok" });
  });

  it("surfaces a failed write instead of silently claiming success", async () => {
    const user = userEvent.setup();
    clerk.update.mockRejectedValue(new Error("network"));
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "active",
        stepIndex: PRODUCT_TOUR_TOTAL - 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    render(<OnboardingOverlay />);
    await screen.findByTestId("tour");
    await user.click(screen.getByText("done"));

    await waitFor(() => expect(toasts.push).toHaveBeenCalled());
    expect(toasts.push.mock.calls[0][0]).toMatchObject({ tone: "fail" });
  });
});

describe("tour dismissal registers separately from completion", () => {
  it("persists 'skipped' at the current step so Resume returns there", async () => {
    const user = userEvent.setup();
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "active",
        stepIndex: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    render(<OnboardingOverlay />);
    const tour = await screen.findByTestId("tour");
    expect(tour.dataset.step).toBe("2");

    await user.click(screen.getByText("skip"));

    await waitFor(() => expect(clerk.update).toHaveBeenCalled());
    // Step is preserved — skipping is a pause, not a reset.
    expect(lastWrite()).toMatchObject({ status: "skipped", stepIndex: 2 });
  });

  it("does not auto-open a skipped (dismissed) tour", async () => {
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "skipped",
        stepIndex: 3,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    nav.search = "";

    render(<OnboardingOverlay />);
    expect(screen.queryByTestId("tour")).not.toBeInTheDocument();
  });

  it("does not hijack /home after Skip — skipped stays closed without ?tour=1", async () => {
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "skipped",
        stepIndex: 3,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    nav.search = "";

    render(<OnboardingOverlay />);
    expect(screen.queryByTestId("tour")).not.toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("auto-resumes an in-progress (active) tour on plain entry too", async () => {
    // "active" = the walkthrough was abandoned mid-step (e.g. browser back
    // out of the tour without pressing Skip). It is unfinished just like
    // "skipped", so it must also reopen by default — same once-per-mount
    // semantics, seeded from the step where the user left off.
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "active",
        stepIndex: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    nav.search = "";

    render(<OnboardingOverlay />);
    const tour = await screen.findByTestId("tour");
    expect(tour.dataset.step).toBe("2");
  });

  it("keeps a skipped tour closed across remounts without a force flag", async () => {
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "skipped",
        stepIndex: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    nav.search = "";

    const view = render(<OnboardingOverlay />);
    expect(screen.queryByTestId("tour")).not.toBeInTheDocument();
    view.rerender(<OnboardingOverlay />);
    expect(screen.queryByTestId("tour")).not.toBeInTheDocument();
  });
});

describe("banner reflects the persisted terminal status", () => {
  it("retires the resume banner once the tour is done", () => {
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "done",
        stepIndex: PRODUCT_TOUR_TOTAL - 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const { container } = render(<OnboardingBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("retires the resume banner after Skip so it does not nag every route", () => {
    clerk.metadata = {
      [EDEN_TOUR_META_KEY]: {
        status: "skipped",
        stepIndex: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const { container } = render(<OnboardingBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});
