import "@testing-library/jest-dom/vitest";

// ── jsdom polyfills ────────────────────────────────────────────────
// jsdom doesn't ship browser APIs that several of our components
// (and their dependencies) reach for. Provide minimal stubs so the
// tests can mount components that use these APIs.
//
// We use ``@ts-ignore`` (rather than ``@ts-expect-error``) on the
// assignments below: once vitest has loaded ``@testing-library/jest-dom``
// earlier in the same run, the type checker can see the relevant
// DOM lib augmentations and the assignment becomes well-typed, which
// would then flag the expect-error directive as unused. Ignore
// keeps the type checker quiet in either case.

// @ts-ignore — ResizeObserver isn't in jsdom's lib by default.
const ResizeObserverStub = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;

// @ts-ignore — IntersectionObserver isn't in jsdom's lib by default.
const IntersectionObserverStub = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  root: Element | null = null;
  rootMargin = "";
  thresholds: ReadonlyArray<number> = [];
};
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  IntersectionObserverStub;

if (typeof window !== "undefined" && typeof window.matchMedia === "undefined") {
  // Radix UI and a handful of other libs probe `window.matchMedia`
  // during render. Provide a stub that always reports "no match".
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// `cmdk` (and some Radix primitives) call `Element.scrollIntoView`
// from a layout effect. jsdom doesn't implement it; stub on the
// Element prototype so the call is a no-op.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* no-op in jsdom */
  };
}
