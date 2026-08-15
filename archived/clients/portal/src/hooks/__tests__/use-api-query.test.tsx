// @vitest-environment jsdom
/**
 * Regression tests for F41-2: ``useApiQuery``/``useOrgQuery``'s
 * ``queryFn`` used to be a zero-argument closure that discarded React
 * Query's ``{ signal }`` (normally passed to ``queryFn(context)`` for
 * automatic cancellation on unmount / query-key-change / refetch) —
 * so no in-flight request across the ~58 call sites in the app was
 * ever aborted. ``queryFn`` now receives ``{ signal }``; a plain
 * zero-arg closure (the existing pattern at nearly every call site)
 * remains valid and behaves exactly as before.
 */
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useApiQuery, useOrgQuery } from "../use-api-query";

function withClient(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useApiQuery — signal threading (F41-2)", () => {
  it("passes an AbortSignal to queryFn, and aborts it on unmount", async () => {
    let receivedSignal: AbortSignal | undefined;

    function Consumer() {
      // Deliberately never-resolving — we want the query still
      // in-flight when we unmount, so cancellation is observable.
      // (A query that has already settled is not cancellable —
      // React Query's own ``Query.cancel()`` is a no-op once the
      // retryer promise has resolved.)
      useApiQuery(["thing"], ({ signal }) => {
        receivedSignal = signal;
        return new Promise<string>(() => {});
      });
      return null;
    }

    const { unmount } = render(withClient(<Consumer />));

    await waitFor(() => expect(receivedSignal).toBeInstanceOf(AbortSignal));
    expect(receivedSignal?.aborted).toBe(false);

    unmount();

    await waitFor(() => expect(receivedSignal?.aborted).toBe(true));
  });

  it("still works with a legacy zero-argument closure that ignores the signal (backward compat for existing ~58 call sites)", async () => {
    let calls = 0;
    let resultText: string | undefined;

    function Consumer() {
      const { data } = useApiQuery(["legacy-thing"], () => {
        calls += 1;
        return Promise.resolve("legacy-value");
      });
      resultText = data;
      return null;
    }

    render(withClient(<Consumer />));

    await waitFor(() => expect(resultText).toBe("legacy-value"));
    expect(calls).toBe(1);
  });
});

describe("useOrgQuery — signal threading (F41-2)", () => {
  it("passes an AbortSignal to queryFn when enabled by orgId", async () => {
    let receivedSignal: AbortSignal | undefined;

    function Consumer() {
      useOrgQuery(["org-thing", "org_1"], "org_1", ({ signal }) => {
        receivedSignal = signal;
        return Promise.resolve("ok");
      });
      return null;
    }

    render(withClient(<Consumer />));

    await waitFor(() => expect(receivedSignal).toBeInstanceOf(AbortSignal));
  });

  it("does not invoke queryFn (or discard-signal-hazard) when orgId is falsy", async () => {
    let called = false;

    function Consumer() {
      useOrgQuery(["org-thing", null], null, () => {
        called = true;
        return Promise.resolve("ok");
      });
      return null;
    }

    render(withClient(<Consumer />));

    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(false);
  });
});
