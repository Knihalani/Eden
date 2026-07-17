"use client";

/**
 * ProductTour — spotlight overlay that introduces each portal surface.
 *
 * Larger card, clearer hierarchy, Escape/X always invoke onSkip (parent
 * closes optimistically). Finish step links to the docs quickstart.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, ExternalLink, X } from "lucide-react";
import {
  PRODUCT_TOUR_STEPS,
  PRODUCT_TOUR_TOTAL,
  type TourStep,
} from "@/lib/product-tour";
import { cn } from "@/lib/utils";

const PAD = 10;
const CARD_W = 440;
const CARD_H = 280;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
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
): { top: number; left: number; side: "right" | "bottom" | "center" | "sheet" } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  if (narrow) {
    return { top: 0, left: 0, side: "sheet" };
  }

  if (!hole) {
    return {
      top: Math.max(32, (vh - CARD_H) / 2),
      left: Math.max(20, (vw - CARD_W) / 2),
      side: "center",
    };
  }

  const rightLeft = hole.left + hole.width + 20;
  if (rightLeft + CARD_W < vw - 20) {
    return {
      top: Math.min(Math.max(20, hole.top), vh - CARD_H - 20),
      left: rightLeft,
      side: "right",
    };
  }

  const belowTop = hole.top + hole.height + 20;
  if (belowTop + CARD_H < vh - 20) {
    return {
      top: belowTop,
      left: Math.min(Math.max(20, hole.left), vw - CARD_W - 20),
      side: "bottom",
    };
  }

  return {
    top: Math.max(20, hole.top - CARD_H - 20),
    left: Math.min(Math.max(20, hole.left), vw - CARD_W - 20),
    side: "bottom",
  };
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

  const refreshHole = useCallback(() => {
    if (!step || step.kind !== "nav") {
      setHole(null);
      return;
    }
    setHole(measureTarget(step.targetId));
  }, [step]);

  useEffect(() => {
    if (!open) return;
    // Fire once when the tour opens — not on every step — so the sidebar
    // does not thrash expand/collapse mid-tour.
    window.dispatchEvent(new Event("eden:product-tour"));
  }, [open]);

  useEffect(() => {
    const sync = () => setNarrow(window.innerWidth < 640);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  useEffect(() => {
    if (!open || !step?.href) return;
    const target = step.href.split("?")[0];
    const here = (pathname || "").split("?")[0];
    if (here === target || here.startsWith(target + "/")) {
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
      if (step.kind === "nav") {
        const r = measureTarget(step.targetId);
        if (r) {
          setHole(r);
          setReady(true);
          navigating.current = false;
          const el = document.querySelector(
            `[data-tour-id="${step.targetId!.replace(/"/g, "")}"]`,
          );
          el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        skipRef.current();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- goNext/goBack close over stepIndex
  }, [open, stepIndex]);

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

  if (!open || typeof document === "undefined") return null;

  const placement = cardPlacement(hole, narrow);
  const isFinish = step.kind === "finish";
  const isWelcome = step.kind === "welcome";
  const progressPct = ((stepIndex + 1) / PRODUCT_TOUR_TOTAL) * 100;
  const isSheet = placement.side === "sheet";

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
            onClick={() => skipRef.current()}
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
                  strokeWidth={2.5}
                  className="pointer-events-none"
                  style={{ filter: "drop-shadow(0 0 10px color-mix(in srgb, var(--accent) 55%, transparent))" }}
                />
              </svg>
            ) : (
              <div className="absolute inset-0 bg-[rgba(4,6,10,0.78)] backdrop-blur-[3px]" />
            )}
          </motion.div>

          {ready && (
            <motion.div
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
                      top: placement.top,
                      left: placement.left,
                      width: `min(${CARD_W}px, calc(100vw - 40px))`,
                    }
              }
              className={cn(
                "pointer-events-auto z-[81] overflow-hidden border border-[var(--border-default)]",
                "bg-[var(--bg-primary)] shadow-[0_24px_64px_rgba(0,0,0,0.55)]",
                isSheet
                  ? "absolute inset-x-0 bottom-0 rounded-t-2xl border-b-0"
                  : "absolute rounded-2xl",
              )}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="h-1 w-full bg-[var(--bg-tertiary)]"
                aria-hidden
              >
                <div
                  className="h-full bg-[var(--accent)] transition-[width] duration-300 ease-out"
                  style={{ width: `${progressPct}%` }}
                />
              </div>

              <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-1 sm:px-6 sm:pt-6">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--accent)]">
                    Product tour · {stepIndex + 1} of {PRODUCT_TOUR_TOTAL}
                  </p>
                  <h2
                    id="eden-tour-title"
                    className="mt-1.5 font-[family-name:var(--font-display)] text-xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-2xl"
                  >
                    {step.title}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => skipRef.current()}
                  aria-label="Close tour"
                  className="shrink-0 rounded-lg p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="px-5 py-4 sm:px-6">
                <p
                  id="eden-tour-body"
                  className="text-[15px] leading-relaxed text-[var(--text-secondary)] sm:text-base"
                >
                  {step.body}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-[var(--border-default)] px-5 py-4 sm:px-6">
                <button
                  type="button"
                  onClick={() => skipRef.current()}
                  className="text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                >
                  Skip
                </button>
                <div className="flex items-center gap-2">
                  {!isWelcome && (
                    <button
                      type="button"
                      disabled={stepIndex === 0}
                      onClick={goBack}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-default)] px-3.5 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Back
                    </button>
                  )}
                  {isFinish && step.ctaHref ? (
                    <>
                      <Link
                        href="/settings?tab=api-keys"
                        className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-default)] px-3.5 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                        onClick={() => onFinish()}
                      >
                        API key
                      </Link>
                      <a
                        href={step.ctaHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-foreground)] transition-opacity hover:opacity-90"
                        onClick={() => onFinish()}
                      >
                        {step.ctaLabel ?? "Open docs"}
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={goNext}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-foreground)] transition-opacity hover:opacity-90"
                    >
                      {isWelcome ? "Start tour" : "Next"}
                      <ArrowRight className="h-4 w-4" />
                    </button>
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
