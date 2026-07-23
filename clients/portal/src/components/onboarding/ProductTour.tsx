"use client";

/**
 * ProductTour — spotlight overlay that introduces each portal surface.
 *
 * Escape / X / Skip always invoke onSkip (parent closes optimistically).
 * Finish step embeds TourGetStartedPanel (filled install snippets).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import {
  PRODUCT_TOUR_STEPS,
  PRODUCT_TOUR_TOTAL,
  type TourStep,
} from "@/lib/product-tour";
import { TourGetStartedPanel } from "@/components/onboarding/TourGetStartedPanel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PAD = 10;
const CARD_W = 440;
const CARD_H = 280;
const FINISH_CARD_W = 520;
const FINISH_CARD_H = 560;

const FOCUSABLE =
  'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function measureTarget(targetId: string | undefined): Rect | null {
  if (!targetId || typeof document === "undefined") return null;
  const el = document.querySelector(
    `[data-tour-id="${targetId.replace(/"/g, "")}"]`,
  ) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 && r.height < 2) return null;
  return {
    top: r.top - PAD,
    left: r.left - PAD,
    width: r.width + PAD * 2,
    height: r.height + PAD * 2,
  };
}

function cardPlacement(
  hole: Rect | null,
  narrow: boolean,
  cardW: number,
  cardH: number,
): { top: number; left: number; side: "right" | "bottom" | "center" | "sheet" } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  if (narrow) {
    return { top: 0, left: 0, side: "sheet" };
  }

  if (!hole) {
    return {
      top: Math.max(24, (vh - cardH) / 2),
      left: Math.max(20, (vw - cardW) / 2),
      side: "center",
    };
  }

  const rightLeft = hole.left + hole.width + 20;
  if (rightLeft + cardW < vw - 20) {
    return {
      top: Math.min(Math.max(20, hole.top), vh - cardH - 20),
      left: rightLeft,
      side: "right",
    };
  }

  const belowTop = hole.top + hole.height + 20;
  if (belowTop + cardH < vh - 20) {
    return {
      top: belowTop,
      left: Math.min(Math.max(20, hole.left), vw - cardW - 20),
      side: "bottom",
    };
  }

  return {
    top: Math.max(20, hole.top - cardH - 20),
    left: Math.min(Math.max(20, hole.left), vw - cardW - 20),
    side: "bottom",
  };
}

/** Normalize settings query so mode=keys and legacy tab=api-keys match. */
function settingsModeFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const mode = params.get("mode");
  if (mode) return mode === "api-keys" ? "keys" : mode;
  const tab = params.get("tab");
  if (tab === "api-keys" || tab === "keys") return "keys";
  if (tab === "org") return "workspace";
  return tab;
}

export interface ProductTourProps {
  open: boolean;
  stepIndex: number;
  onStepChange: (index: number) => void;
  onSkip: () => void;
  onFinish: () => void;
  busy?: boolean;
}

export function ProductTour({
  open,
  stepIndex,
  onStepChange,
  onSkip,
  onFinish,
  busy = false,
}: ProductTourProps) {
  const router = useRouter();
  const pathname = usePathname();
  const step: TourStep =
    PRODUCT_TOUR_STEPS[Math.min(stepIndex, PRODUCT_TOUR_TOTAL - 1)] ??
    PRODUCT_TOUR_STEPS[0];
  const [hole, setHole] = useState<Rect | null>(null);
  const [ready, setReady] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const navigating = useRef(false);
  const skipRef = useRef(onSkip);
  skipRef.current = onSkip;
  const cardRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const refreshHole = useCallback(() => {
    if (!step || step.kind !== "nav" || !step.targetId) {
      setHole(null);
      return;
    }
    setHole(measureTarget(step.targetId));
  }, [step]);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new Event("eden:product-tour"));
    return () => {
      window.dispatchEvent(new Event("eden:product-tour-end"));
    };
  }, [open]);

  useEffect(() => {
    const sync = () => setNarrow(window.innerWidth < 640);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open || !ready) return;
    const root = cardRef.current;
    if (!root) return;
    const primary =
      root.querySelector<HTMLElement>("[data-tour-primary]") ??
      root.querySelector<HTMLElement>(FOCUSABLE);
    primary?.focus({ preventScroll: true });
  }, [open, ready, stepIndex]);

  useEffect(() => {
    if (!open || !step?.href) return;
    const targetUrl = new URL(step.href, "http://eden.local");
    const herePath = (pathname || "").split("?")[0] || "/";
    const targetPath = targetUrl.pathname;
    const pathMatches =
      herePath === targetPath || herePath.startsWith(targetPath + "/");
    const wantMode = settingsModeFromSearch(targetUrl.search);
    const hereMode =
      typeof window !== "undefined"
        ? settingsModeFromSearch(window.location.search)
        : null;
    const modeMatches = !wantMode || wantMode === hereMode;
    if (pathMatches && modeMatches) {
      navigating.current = false;
      return;
    }
    navigating.current = true;
    setReady(false);
    router.push(step.href);
  }, [open, step?.href, step?.id, pathname, router]);

  useLayoutEffect(() => {
    if (!open) return;
    let cancelled = false;
    let attempts = 0;

    const tick = () => {
      if (cancelled) return;
      if (step.kind === "nav" && step.targetId) {
        const r = measureTarget(step.targetId);
        if (r) {
          setHole(r);
          setReady(true);
          navigating.current = false;
          const el = document.querySelector(
            `[data-tour-id="${step.targetId.replace(/"/g, "")}"]`,
          );
          el?.scrollIntoView({
            block: "nearest",
            behavior: prefersReducedMotion() ? "auto" : "smooth",
          });
          return;
        }
        attempts += 1;
        if (attempts < 40) {
          requestAnimationFrame(tick);
          return;
        }
        setHole(null);
        setReady(true);
        return;
      }
      setHole(null);
      setReady(true);
    };

    const t = window.setTimeout(tick, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, step, pathname, stepIndex]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => refreshHole();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, refreshHole]);

  function goNext() {
    if (busy) return;
    if (stepIndex >= PRODUCT_TOUR_TOTAL - 1) {
      onFinish();
      return;
    }
    setReady(false);
    onStepChange(stepIndex + 1);
  }

  function goBack() {
    if (busy || stepIndex <= 0) return;
    setReady(false);
    onStepChange(stepIndex - 1);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        skipRef.current();
        return;
      }

      if (e.key === "Tab" && cardRef.current) {
        const nodes = Array.from(
          cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
        ).filter(
          (el) => el.offsetParent !== null || el === document.activeElement,
        );
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !cardRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last || !cardRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        }
        return;
      }

      if (e.key === "ArrowRight" || e.key === "Enter") {
        const target = e.target as HTMLElement | null;
        if (
          target?.closest?.(
            "a, button, [role='button'], textarea, input, select",
          )
        ) {
          return;
        }
        e.preventDefault();
        if (busy) return;
        if (stepIndex >= PRODUCT_TOUR_TOTAL - 1) {
          onFinish();
          return;
        }
        setReady(false);
        onStepChange(stepIndex + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (busy || stepIndex <= 0) return;
        setReady(false);
        onStepChange(stepIndex - 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, stepIndex, busy, onFinish, onStepChange]);

  if (!open || typeof document === "undefined") return null;

  const isFinish = step.kind === "finish";
  const isWelcome = step.kind === "welcome";
  const cardW = isFinish ? FINISH_CARD_W : CARD_W;
  const cardH = isFinish ? FINISH_CARD_H : CARD_H;
  const placement = cardPlacement(hole, narrow, cardW, cardH);
  const progressPct = ((stepIndex + 1) / PRODUCT_TOUR_TOTAL) * 100;
  const isSheet = placement.side === "sheet";

  function dismissUnlessHole(e: ReactMouseEvent) {
    if (hole) {
      const x = e.clientX;
      const y = e.clientY;
      if (
        x >= hole.left &&
        x <= hole.left + hole.width &&
        y >= hole.top &&
        y <= hole.top + hole.height
      ) {
        return;
      }
    }
    skipRef.current();
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-[80]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="eden-tour-title"
          aria-describedby="eden-tour-body"
        >
          <motion.div
            key={`mask-${step.id}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="absolute inset-0"
            onClick={dismissUnlessHole}
          >
            {hole && !narrow ? (
              <svg className="absolute inset-0 h-full w-full" aria-hidden>
                <defs>
                  <mask id="eden-tour-mask">
                    <rect width="100%" height="100%" fill="white" />
                    <rect
                      x={hole.left}
                      y={hole.top}
                      width={hole.width}
                      height={hole.height}
                      rx={12}
                      fill="black"
                    />
                  </mask>
                </defs>
                <rect
                  width="100%"
                  height="100%"
                  fill="rgba(4, 6, 10, 0.78)"
                  mask="url(#eden-tour-mask)"
                />
                <rect
                  x={hole.left}
                  y={hole.top}
                  width={hole.width}
                  height={hole.height}
                  rx={12}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  className="pointer-events-none"
                />
              </svg>
            ) : (
              <div className="absolute inset-0 bg-[rgba(4,6,10,0.78)]" />
            )}
          </motion.div>

          {ready && (
            <motion.div
              ref={cardRef}
              key={`card-${step.id}`}
              initial={
                isSheet
                  ? { opacity: 0, y: 48 }
                  : { opacity: 0, y: 12, scale: 0.97 }
              }
              animate={
                isSheet
                  ? { opacity: 1, y: 0 }
                  : { opacity: 1, y: 0, scale: 1 }
              }
              exit={
                isSheet
                  ? { opacity: 0, y: 32 }
                  : { opacity: 0, y: 8, scale: 0.98 }
              }
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              style={
                isSheet
                  ? undefined
                  : {
                      top: Math.max(16, placement.top),
                      left: placement.left,
                      width: `min(${cardW}px, calc(100vw - 40px))`,
                      maxHeight: "min(90vh, calc(100dvh - 32px))",
                    }
              }
              className={cn(
                "pointer-events-auto z-[81] flex flex-col overflow-hidden border border-[var(--border-default)]",
                "bg-[var(--bg-primary)] shadow-[0_24px_64px_rgba(0,0,0,0.55)]",
                isSheet
                  ? "absolute inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)]"
                  : "absolute rounded-2xl",
              )}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="h-1 w-full shrink-0 bg-[var(--bg-tertiary)]" aria-hidden>
                <div
                  className="h-full bg-[var(--accent)] transition-[width] duration-300 ease-out"
                  style={{ width: `${progressPct}%` }}
                />
              </div>

              <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 pb-1 sm:px-6 sm:pt-6">
                <div className="min-w-0">
                  <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-[var(--accent)]">
                    Product tour · {stepIndex + 1} / {PRODUCT_TOUR_TOTAL}
                  </p>
                  <h2
                    id="eden-tour-title"
                    className="mt-2 font-[family-name:var(--font-display)] text-xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-2xl"
                  >
                    {step.title}
                  </h2>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => skipRef.current()}
                  aria-label="Close tour"
                  className="min-h-11 min-w-11 shrink-0 !px-0"
                >
                  <X className="h-5 w-5" />
                </Button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
                {isFinish ? (
                  <>
                    <p id="eden-tour-body" className="sr-only">
                      {step.body}
                    </p>
                    <TourGetStartedPanel />
                  </>
                ) : (
                  <p
                    id="eden-tour-body"
                    className="text-sm leading-relaxed text-[var(--text-secondary)] sm:text-base"
                  >
                    {step.body}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] px-5 py-4 sm:px-6">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => skipRef.current()}
                  className="min-h-11"
                >
                  Skip tour
                </Button>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {!isWelcome && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={stepIndex === 0}
                      onClick={goBack}
                      className="min-h-11"
                    >
                      <ArrowLeft className="mr-1.5 h-4 w-4" />
                      Back
                    </Button>
                  )}
                  {isFinish ? (
                    <Button
                      type="button"
                      onClick={onFinish}
                      data-tour-primary
                      className="min-h-11"
                    >
                      Done
                    </Button>
                  ) : step.ctaHref ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={goNext}
                        className="min-h-11"
                      >
                        {isWelcome ? "Start tour" : "Next"}
                        <ArrowRight className="ml-1.5 h-4 w-4" />
                      </Button>
                      {step.ctaExternal ? (
                        <a
                          href={step.ctaHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-tour-primary
                          data-tour-cta
                          className="ds-btn ds-btn-primary min-h-11"
                        >
                          {step.ctaLabel ?? "Open"}
                        </a>
                      ) : (
                        <Link
                          href={step.ctaHref}
                          data-tour-primary
                          data-tour-cta
                          className="ds-btn ds-btn-primary min-h-11"
                        >
                          {step.ctaLabel ?? "Open"}
                          <ArrowRight className="ml-1.5 h-4 w-4" />
                        </Link>
                      )}
                    </>
                  ) : (
                    <Button
                      type="button"
                      onClick={goNext}
                      data-tour-primary
                      className="min-h-11"
                    >
                      {isWelcome ? "Start tour" : "Next"}
                      <ArrowRight className="ml-1.5 h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
