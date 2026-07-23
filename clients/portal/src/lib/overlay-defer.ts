/**
 * Overlay deferral — avoid stacking cookie / product-tour chrome
 * on top of session banners or in-page ErrorState.
 *
 * Portal chrome writes ``data-eden-chrome-banner`` on ``<html>``.
 * QueryErrorPanel writes ``data-eden-error-state`` on ``<html>``.
 */

export const CHROME_BANNER_ATTR = "data-eden-chrome-banner";
export const ERROR_STATE_ATTR = "data-eden-error-state";

/** True when a blocking chrome banner or ErrorState is on screen. */
export function shouldDeferBlockingOverlays(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  if (root.getAttribute(CHROME_BANNER_ATTR) === "1") return true;
  return root.getAttribute(ERROR_STATE_ATTR) === "1";
}
