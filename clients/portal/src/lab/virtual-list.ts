import {
  measureElement as defaultMeasureElement,
  type Virtualizer,
} from "@tanstack/react-virtual";

/**
 * Marker attribute on every virtualised scroll container.
 *
 * The virtualiser derives its window from the scroll element's
 * `getBoundingClientRect()`. jsdom has no layout engine, so that is
 * always 0×0 and `calculateRange()` bails out with an empty range —
 * which would make every virtualised list render as an empty box under
 * test. `vitest.setup.ts` hands elements carrying this attribute a
 * synthetic viewport so component tests can exercise the real code
 * path. It is inert in a browser.
 */
export const VIRTUAL_SCROLL_ATTR = "data-virtual-scroll";

/**
 * `measureElement` that refuses a zero reading.
 *
 * A mounted, non-empty row is never genuinely 0px tall; a zero means
 * either "no layout engine" (jsdom) or "measured before first paint".
 * Writing that into the size cache collapses `getTotalSize()` to 0,
 * which in turn makes the range calculation cover the whole list — the
 * exact opposite of virtualising. Falling back to the estimate keeps
 * the geometry usable until a real measurement arrives.
 */
export function measureVirtualRow<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  element: TItemElement,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<TScrollElement, TItemElement>,
): number {
  const measured = defaultMeasureElement(element, entry, instance);
  if (measured > 0) return measured;
  return instance.options.estimateSize(instance.indexFromElement(element));
}
