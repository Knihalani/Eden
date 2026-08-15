import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * Regression test for the write-serialization guarantee documented at the
 * top of use-tour-progress.ts: "Writes are serialized so rapid Next/Back
 * cannot lose steps via overlapping read-modify-write against
 * `unsafeMetadata`."
 *
 * This hook is mounted by more than one component at once in production
 * (OnboardingOverlay + OnboardingBanner both call `useTourProgress()`). A
 * per-hook-instance `useRef` write queue cannot deliver that guarantee once
 * a second mounted instance can issue a concurrent `.update()` call — each
 * instance only serializes writes against itself. This test mounts the
 * hook twice (mirroring the two real call sites) and asserts that Clerk's
 * `.update()` is never called more than once concurrently, and that the
 * write issued *last* always wins, regardless of two components racing to
 * write around the same time.
 */

const state = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
}));
const updateMock = vi.hoisted(() => vi.fn());

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    // A fresh object every call — models Clerk potentially handing back a
    // new `user`/`unsafeMetadata` identity on each render/update, which this
    // file's own longstanding comment already anticipated.
    user: {
      id: "user_1",
      unsafeMetadata: state.metadata,
      update: updateMock,
    },
    isLoaded: true,
  }),
}));

import { useTourProgress } from "./use-tour-progress";

describe("useTourProgress write serialization across mounted instances", () => {
  let pending: Array<() => void>;

  beforeEach(() => {
    state.metadata = {};
    pending = [];
    updateMock.mockReset();
    updateMock.mockImplementation(
      (patch: { unsafeMetadata: Record<string, unknown> }) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            state.metadata = patch.unsafeMetadata;
            resolve();
          });
        }),
    );
  });

  it("never has more than one Clerk update() in flight, and the later call wins", async () => {
    // Two independent mounted instances of the hook, exactly like
    // OnboardingOverlay and OnboardingBanner mounted together.
    const instanceA = renderHook(() => useTourProgress());
    const instanceB = renderHook(() => useTourProgress());

    let doneA = false;
    let doneB = false;

    // Instance A advances first ...
    act(() => {
      instanceA.result.current.setStepIndex(1).then(() => {
        doneA = true;
      });
    });
    // ... instance B advances a moment later, before A's write has settled.
    act(() => {
      instanceB.result.current.setStepIndex(4).then(() => {
        doneB = true;
      });
    });

    // Flush the synchronous/microtask portion of both calls (up to each
    // one's `await user.update(...)`), without letting Clerk's own async
    // work (gated behind `pending`) resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The core guarantee under test: only ONE write may be in flight at a
    // time, no matter how many components have this hook mounted. A
    // per-instance `useRef` chain fails this — instance A and instance B
    // each had their own independent queue, so both `update()` calls would
    // already have been dispatched concurrently at this point.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
    expect(doneA).toBe(false);
    expect(doneB).toBe(false);

    // Let A's write land.
    await act(async () => {
      pending[0]();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(doneA).toBe(true);
    // Only now should B's write actually reach Clerk's update().
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(doneB).toBe(false);

    // Let B's write land.
    await act(async () => {
      pending[1]();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(doneB).toBe(true);

    // Final persisted state reflects call order (B was issued after A), not
    // whichever `update()` happened to be dispatched or resolved first.
    const secondCallMeta = updateMock.mock.calls[1][0].unsafeMetadata
      .edenTour as { stepIndex: number };
    expect(secondCallMeta.stepIndex).toBe(4);
    expect(
      (state.metadata.edenTour as { stepIndex: number }).stepIndex,
    ).toBe(4);
  });
});
