"use client";

/**
 * Retry-capable replacement for bare `next/dynamic()` panels.
 *
 * `next/dynamic` is a thin wrapper over `React.lazy` + `Suspense`. Once the
 * underlying `import()` rejects (e.g. a stale/evicted JS chunk after a
 * deploy), `React.lazy`'s internal `_status` is permanently cached as
 * rejected and the lazy component re-throws on *every* subsequent render —
 * Suspense doesn't catch a genuine throw, so it propagates to the nearest
 * error boundary and tears down whatever page hosts it. Clicking "Try
 * again" on a page-level error boundary just re-renders the same
 * module-scoped rejected `Lazy` singleton, which throws again immediately.
 *
 * `dynamicWithRetry()` fixes both problems:
 *  - each retry constructs a *fresh* `React.lazy(() => import(...))`, so the
 *    retry re-issues a brand-new `import()` instead of replaying a cached
 *    rejection;
 *  - a local error boundary contains the failure to the panel itself
 *    (callers should NOT need to rely on `app/(portal)/error.tsx`).
 */

import {
  Component,
  lazy,
  Suspense,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

type ImportResult<P> = { default: ComponentType<P> };
type ImportFn<P> = () => Promise<ImportResult<P>>;

export interface DynamicWithRetryOptions<P> {
  /** Rendered while the chunk is loading (mirrors next/dynamic's `loading`). */
  loading?: () => ReactNode;
  /** Optional per-attempt import budget; past this the attempt fails with a timeout error. */
  timeoutMs?: number;
  /** Custom failure UI. Defaults to a compact message + "Retry" button. */
  errorFallback?: (error: Error, retry: () => void) => ReactNode;
  /** Unused at runtime — lets callers pin the prop type when inference is ambiguous. */
  __props?: P;
}

function withTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T> {
  if (!ms) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Chunk load timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function defaultErrorFallback(error: Error, retry: () => void): ReactNode {
  return (
    <div className="flex min-h-[8rem] flex-col items-center justify-center gap-2 px-5 text-center">
      <p className="type-meta text-[var(--text-secondary)]">
        {error.message || "This panel failed to load."}
      </p>
      <button
        type="button"
        className="ds-btn ds-btn-ghost ds-btn-sm"
        onClick={retry}
      >
        Retry
      </button>
    </div>
  );
}

interface PanelErrorBoundaryProps {
  children: ReactNode;
  onRetry: () => void;
  fallback: (error: Error, retry: () => void) => ReactNode;
}

interface PanelErrorBoundaryState {
  error: Error | null;
}

/**
 * Local error boundary so a chunk-load failure in one dynamic panel doesn't
 * propagate to the page-level `error.tsx` and tear down the whole view.
 */
class PanelErrorBoundary extends Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  state: PanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("[dynamic-with-retry] panel failed to load", error);
  }

  private handleRetry = (): void => {
    // Remount via parent `key={attempt}` first so the next render gets a
    // fresh `React.lazy` — clearing local error alone would re-render the
    // same permanently-rejected lazy singleton.
    this.props.onRetry();
  };

  render(): ReactNode {
    if (this.state.error) {
      return this.props.fallback(this.state.error, this.handleRetry);
    }
    return this.props.children;
  }
}

/**
 * Drop-in, retry-capable alternative to `next/dynamic(() => import(...))`.
 *
 * Each retry attempt increments an `attempt` counter, which (a) remounts the
 * error boundary (clearing its caught-error state) and (b) rebuilds
 * `React.lazy` from scratch — so the retry always fires a fresh `import()`
 * rather than reusing the permanently-rejected `Lazy` singleton.
 */
export function dynamicWithRetry<P extends object>(
  importFn: ImportFn<P>,
  options: DynamicWithRetryOptions<P> = {},
): ComponentType<P> {
  const { loading, timeoutMs, errorFallback = defaultErrorFallback } = options;

  function DynamicWithRetry(props: P) {
    const [attempt, setAttempt] = useState(0);

    // Recreated on every retry so we never reuse a rejected React.lazy
    // instance — each attempt gets its own promise-backed component.
    // Deliberately keyed only on `attempt`: `importFn`/`timeoutMs` are the
    // caller-provided options for this dynamic component and are treated as
    // stable for its lifetime, matching next/dynamic's own semantics.
    const LazyComponent = useMemo(
      () => lazy(() => withTimeout(importFn(), timeoutMs)),
      [attempt],
    );

    return (
      <PanelErrorBoundary
        key={attempt}
        onRetry={() => setAttempt((n) => n + 1)}
        fallback={errorFallback}
      >
        <Suspense fallback={loading ? loading() : null}>
          <LazyComponent {...props} />
        </Suspense>
      </PanelErrorBoundary>
    );
  }

  DynamicWithRetry.displayName = "DynamicWithRetry";
  return DynamicWithRetry;
}
