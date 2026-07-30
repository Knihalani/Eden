import "@testing-library/jest-dom/vitest";
import { ApiError } from "@/lib/api/core";

// fetchApi negative-path tests can reject before vitest attaches `.catch`.
// Swallow expected ApiError rejections so the suite stays clean.
process.on("unhandledRejection", (reason: unknown) => {
  if (reason instanceof ApiError) return;
});

// ── jsdom polyfills ────────────────────────────────────────────────
// jsdom doesn't ship browser APIs that several of our components
// (and their dependencies) reach for. Provide minimal stubs so the
// tests can mount components that use these APIs.
//
// We assign to `globalThis` via an `unknown` cast because the lib
// types may or may not include these globals depending on the
// tsconfig — using `as unknown as { ResizeObserver: unknown }`
// keeps the assignment well-typed under either jsdom-lib presence
// or absence without needing @ts-ignore / @ts-expect-error
// directives that the type checker may then flag as unused.

const ResizeObserverStub = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;

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

// @tanstack/react-virtual sizes its window from the scroll element's
// `offsetWidth` / `offsetHeight`. jsdom has no layout engine, so both
// are always 0 and virtual-core's `calculateRange()` returns null —
// every virtualised list would render as an empty box and the
// components using one would be untestable. Give containers that opt
// in (see `VIRTUAL_SCROLL_ATTR` in src/lab/virtual-list.ts) a synthetic
// viewport; every other element keeps jsdom's real answer of 0.
const VIRTUAL_TEST_VIEWPORT = { width: 320, height: 600 };
if (typeof HTMLElement !== "undefined") {
  for (const [prop, value] of [
    ["offsetWidth", VIRTUAL_TEST_VIEWPORT.width],
    ["offsetHeight", VIRTUAL_TEST_VIEWPORT.height],
  ] as const) {
    const native = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      prop,
    );
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        if (this.hasAttribute("data-virtual-scroll")) return value;
        return native?.get ? native.get.call(this) : 0;
      },
    });
  }
}

// `cmdk` (and some Radix primitives) call `Element.scrollIntoView`
// from a layout effect. jsdom doesn't implement it; stub on the
// Element prototype so the call is a no-op.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* no-op in jsdom */
  };
}