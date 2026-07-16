"use client";

/**
 * ProductTour — spotlight overlay that introduces each portal surface.
 *
 * Renders a dimmed mask with a hole around `[data-tour-id]`, a floating
 * card with copy + Next/Back/Skip, and navigates between routes as the
 * user advances. Finish step links to the docs quickstart.
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

const PAD = 8;

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
): { top: number; left: number; side: "right" | "bottom" | "center" } {
  const cardW = 360;
  const cardH = 220;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  if (!hole) {
    return {
      top: Math.max(24, (vh - cardH) / 2),
      left: Math.max(16, (vw - cardW) / 2),
      side: "center",
    };
  }

  // Prefer right of sidebar target
  const rightLeft = hole.left + hole.width + 16;
  if (rightLeft + cardW < vw - 16) {
    return {
      top: Math.min(Math.max(16, hole.top), vh - cardH - 16),
      left: rightLeft,
      side: "right",
    };
  }

  // Else below
  const belowTop = hole.top + hole.height + 16;
  if (belowTop + cardH < vh - 16) {
    return {
      top: belowTop,
      left: Math.min(Math.max(16, hole.left), vw - cardW - 16),
      side: "bottom",
    };
  }

  return {
    top: Math.max(16, hole.top - cardH - 16),
    left: Math.min(Math.max(16, hole.left), vw - cardW - 16),
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
  const navigating = useRef(false);

  const refreshHole = useCallback(() => {
    if (!step || step.kind !== "nav") {
      setHole(null);
      return;
    }
    setHole(measureTarget(step.targetId));
  }, [step]);

  // Ask layout to expand the sidebar so nav targets are measurable.
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new Event("eden:product-tour"));
  }, [open, stepIndex]);

  // Navigate to the step's route when needed.
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

  // After navigation / open, wait for target + measure.
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
          // Scroll target into view in sidebar
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
        // Fallback: no spotlight, still show card
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
        onSkip();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- goNext/goBack close over stepIndex
  }, [open, stepIndex, onSkip]);

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

  const placement = cardPlacement(hole);
  const isFinish = step.kind === "finish";
  const isWelcome = step.kind === "welcome";
  const progressLabel = `${stepIndex + 1} / ${PRODUCT_TOUR_TOTAL}`;

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
          {/* Spotlight mask */}
          <motion.div
            key={`mask-${step.id}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0"
            onClick={() => onSkip()}
          >
            {hole ? (
              <svg className="absolute inset-0 h-full w-full" aria-hidden>
                <defs>
                  <mask id="eden-tour-mask">
                    <rect width="100%" height="100%" fill="white" />
                    <rect
                      x={hole.left}
                      y={hole.top}
                      width={hole.width}
                      height={hole.height}
                      rx={10}
                      fill="black"
                    />
                  </mask>
                </defs>
                <rect
                  width="100%"
                  height="100%"
                  fill="rgba(6, 8, 12, 0.72)"
                  mask="url(#eden-tour-mask)"
                />
                <rect
                  x={hole.left}
                  y={hole.top}
                  width={hole.width}
                  height={hole.height}
                  rx={10}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  className="pointer-events-none"
                />
              </svg>
            ) : (
              <div className="absolute inset-0 bg-[rgba(6,8,12,0.72)] backdrop-blur-[2px]" />
            )}
          </motion.div>

          {/* Floating card */}
          {ready && (
            <motion.div
              key={`card-${step.id}`}
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              style={{
                top: placement.top,
                left: placement.left,
                width: "min(360px, calc(100vw - 32px))",
              }}
              className={cn(
                "pointer-events-auto absolute z-[81] rounded-xl border border-[var(--border-default)]",
                "bg-[var(--bg-primary)] shadow-2xl shadow-black/40",
              )}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-[var(--border-default)] px-4 py-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    Product tour · {progressLabel}
                  </p>
                  <h2
                    id="eden-tour-title"
                    className="mt-0.5 text-base font-semibold text-[var(--text-primary)]"
                  >
                    {step.title}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => onSkip()}
                  disabled={busy}
                  aria-label="Skip tour"
                  className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="px-4 py-3">
                <p
                  id="eden-tour-body"
                  className="text-sm leading-relaxed text-[var(--text-secondary)]"
                >
                  {step.body}
                </p>

                {/* Progress dots */}
                <div className="mt-4 flex flex-wrap gap-1" aria-hidden>
                  {PRODUCT_TOUR_STEPS.map((s, i) => (
                    <div
                      key={s.id}
                      className={cn(
                        "h-1 w-3 rounded-full transition-colors",
                        i === stepIndex
                          ? "bg-[var(--accent)]"
                          : i < stepIndex
                            ? "bg-[var(--accent)]/40"
                            : "bg-[var(--bg-tertiary)]",
                      )}
                    />
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-[var(--border-default)] px-4 py-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSkip()}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                  Skip tour
                </button>
                <div className="flex items-center gap-2">
                  {!isWelcome && (
                    <button
                      type="button"
                      disabled={busy || stepIndex === 0}
                      onClick={goBack}
                      className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-default)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                      Back
                    </button>
                  )}
                  {isFinish && step.ctaHref ? (
                    <>
                      <Link
                        href="/settings?tab=api-keys"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                        onClick={() => onFinish()}
                      >
                        Create API key
                      </Link>
                      <a
                        href={step.ctaHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--bg-primary)] hover:opacity-90"
                        onClick={() => onFinish()}
                      >
                        {step.ctaLabel ?? "Open docs"}
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={goNext}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50"
                    >
                      {isWelcome ? "Start tour" : "Next"}
                      <ArrowRight className="h-3.5 w-3.5" />
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
