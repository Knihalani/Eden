"use client";

/**
 * Generic <Wizard> — a headless multi-step wizard.
 *
 * Used by the onboarding flow, but generic enough to power any
 * multi-step UI (a "create agent" wizard, a "set up alert" wizard,
 * etc.). State is stored in localStorage so a refresh resumes the
 * user where they left off.
 *
 * Phase 2 of the June 2026 UI overhaul. The old onboarding/layout.tsx
 * had a hardcoded STEPS array and 5 sibling page files, each with
 * their own state. This consolidates the chrome + flow control in
 * one place.
 *
 * Steps declare:
 *   - id, slug (route path), label (progress chip)
 *   - optional: marks the step as skippable
 *   - render(ctx): the step body
 *   - canAdvance(ctx): optional gate, false blocks "Next"
 *   - onNext(ctx): optional hook, return value is the next slug
 *   - skip: declared via `optional: true`
 */

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight, ArrowLeft, Check, SkipForward } from "lucide-react";
import { cn } from "@/lib/utils";

export interface WizardContext {
  /** Per-step state bag (use the slug as a key for cross-step data). */
  state: Record<string, unknown>;
  setState: (key: string, value: unknown) => void;
  /** URL query params at the time of the step rendering. */
  query: Record<string, string>;
  /** True while a server action is in flight (set by the step body). */
  busy: boolean;
  setBusy: (b: boolean) => void;
  /** Navigate to a different step (still inside the wizard). */
  goTo: (slug: string) => void;
}

export interface WizardStep {
  id: string;
  slug: string;
  label: string;
  optional?: boolean;
  /** Optional body renderer. The route page (e.g.
   *  ``(portal)/onboarding/[step]/page.tsx``) is the canonical
   *  source of body content; ``render`` is only needed if the
   *  wizard should mount the body for a slug with no page file
   *  (e.g. an embedded surface). */
  render?: (ctx: WizardContext) => React.ReactNode;
  canAdvance?: (ctx: WizardContext) => boolean | Promise<boolean>;
  /** Return value is the next slug. If omitted, the wizard advances to
   *  the next non-skipped step in the array. */
  onNext?: (ctx: WizardContext) => string | void | Promise<string | void>;
}

export interface WizardProps {
  steps: WizardStep[];
  /** localStorage key for skipped + state persistence. */
  storageKey: string;
  /** Slug that shows the "Done" CTA instead of "Next". */
  completeSlug: string;
  /** Optional brand label in the top bar. Empty string hides it. */
  brand?: { name?: string; tagline?: string };
  /** Optional custom progress UI; defaults to the built-in stepper. */
  progressBar?: React.ReactNode;
  children?: React.ReactNode;
  /** Optional "Skip to ..." link in the top bar (default: /dashboard). */
  skipHref?: string;
}

export function Wizard({
  steps,
  storageKey,
  completeSlug,
  brand = { name: "Eden" },
  progressBar,
  children,
  skipHref = "/dashboard",
}: WizardProps) {
  const router = useRouter();
  const pathname = usePathname() || steps[0]?.slug || "/";

  // localStorage persistence — lazy initial state. Reading the
  // persisted shape once at mount is a side-effect of React's
  // external system (localStorage), so it goes in the lazy
  // initializer rather than a useEffect that setState's
  // synchronously (which is the React 19 purity rule's complaint).
  // SSR returns an empty value because `window` isn't defined on
  // the server; the first client render re-reads the persisted
  // shape and the hydration markup matches.
  const [skipped, setSkipped] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { skipped?: string[] };
      return Array.isArray(parsed.skipped) ? parsed.skipped : [];
    } catch {
      return [];
    }
  });
  const [state, setStateRecord] = useState<Record<string, unknown>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
      return parsed.state && typeof parsed.state === "object" ? parsed.state : {};
    } catch {
      return {};
    }
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ skipped, state })
      );
    } catch {
      // tolerate
    }
  }, [storageKey, skipped, state]);

  // Compute the visible step list (excludes skipped).
  const visibleSteps = useMemo(
    () => steps.filter((s) => !skipped.includes(s.id)),
    [steps, skipped]
  );

  // Active step: by URL or, if pathname doesn't match any step, the first visible one.
  const activeStep = useMemo(
    () => visibleSteps.find((s) => pathname === s.slug) ?? visibleSteps[0],
    [pathname, visibleSteps]
  );

  const activeIdx = activeStep ? visibleSteps.indexOf(activeStep) : -1;
  const isComplete = pathname === completeSlug;
  const progress = activeIdx >= 0 ? ((activeIdx + 1) / Math.max(visibleSteps.length, 1)) * 100 : 0;

  const setState = (key: string, value: unknown) =>
    setStateRecord((prev) => ({ ...prev, [key]: value }));

  // FIX-S: hard-navigation helper. window.location.assign is more
  // reliable than Next.js's app-router push on the (portal) route
  // group during the Clerk hydration window — the SPA push has
  // been observed silently no-op'ing there. The wizard is in-flow
  // navigation, so a hard reload is acceptable. Declared early so
  // goTo + the advance handlers below can reference it.
  const navigateTo = (slug: string) => {
    if (typeof window !== "undefined") {
      window.location.assign(slug);
    } else {
      router.push(slug);
    }
  };

  const goTo = (slug: string) => navigateTo(slug);

  // Build a query object from the current URL.
  const query: Record<string, string> = useMemo(() => {
    if (typeof window === "undefined") return {};
    const out: Record<string, string> = {};
    const search = window.location.search.replace(/^\?/, "");
    if (!search) return out;
    for (const pair of search.split("&")) {
      const [k, v = ""] = pair.split("=");
      if (k) out[decodeURIComponent(k)] = decodeURIComponent(v);
    }
    return out;
  }, [pathname]);

  const ctx: WizardContext = { state, setState, query, busy, setBusy, goTo };

  // Advance logic. See navigateTo above for the hard-nav rationale.
  // (The FIX-S comment lives on the navigateTo declaration so it
  // applies to every call site without being repeated.)
  const onNext = async () => {
    if (!activeStep) return;
    if (activeStep.canAdvance) {
      const ok = await activeStep.canAdvance(ctx);
      if (!ok) return;
    }
    const nextSlug = (await activeStep.onNext?.(ctx)) as string | undefined;
    if (typeof nextSlug === "string" && nextSlug) {
      navigateTo(nextSlug);
      return;
    }
    const nextIdx = activeIdx + 1;
    if (nextIdx < visibleSteps.length) {
      navigateTo(visibleSteps[nextIdx].slug);
    } else {
      navigateTo(completeSlug);
    }
  };

  const onBack = () => {
    const prevIdx = activeIdx - 1;
    if (prevIdx >= 0) navigateTo(visibleSteps[prevIdx].slug);
  };

  const onSkipStep = () => {
    if (!activeStep?.optional) return;
    setSkipped((s) => Array.from(new Set([...s, activeStep.id])));
    // Advance after marking skipped
    const nextIdx = activeIdx + 1;
    if (nextIdx < visibleSteps.length) {
      navigateTo(visibleSteps[nextIdx].slug);
    } else {
      navigateTo(completeSlug);
    }
  };

  return (
    // FIX-Q: drop ``min-h-full`` from the wizard outer. The previous
    // ``min-h-full`` forced the wizard chrome (top bar + progress
    // strip + body + bottom nav) to be at LEAST the parent
    // flex-1 column's height. On a viewport where the welcome
    // content + chrome summed to more than the parent column
    // could hold, the wizard grew past the viewport, the bottom
    // nav was pushed off-screen, and the user had to scroll the
    // document to see the Back/Next buttons. Switching to a plain
    // flex column lets the wizard size to its content; the
    // (portal) layout's existing document-scroll handles overflow
    // (FIX-A / FIX-B). The body keeps `flex-1` so on short pages
    // the body still takes any leftover vertical space.
    <div className="flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[calc(100dvh-3.5rem)]">
      {/* Top bar — compact: single line, h-12 */}
      <div className="flex h-12 items-center border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-6">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between">
          <div className="flex items-center gap-3">
            {brand?.name && (
              <span className="text-sm font-semibold tracking-tight">{brand.name}</span>
            )}
            {brand?.tagline && (
              <span className="text-xs text-[var(--text-muted)]">— {brand.tagline}</span>
            )}
          </div>
          <button
            onClick={() => {
              try {
                window.localStorage.removeItem(storageKey);
              } catch {
                // tolerate
              }
              navigateTo(skipHref);
            }}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Skip to dashboard →
          </button>
        </div>
      </div>

      {/* Progress strip — compact: just a thin progress bar + step
          counter. The previous version showed every step label as a
          chevron list (3+rem of vertical space), which combined with
          the top bar + bottom nav pushed the welcome page past the
          viewport on a 1080p screen ("expands too far down"). The
          label list is available via the bottom-nav aria-label if a
          screen reader user needs to know their position; sighted
          users see the bar fill as they advance. */}
      <div className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-1.5">
        <div className="mx-auto max-w-3xl">
          {progressBar ?? (
            <>
              <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                <span>
                  Step {Math.max(activeIdx + 1, 1)} of {visibleSteps.length}
                  {activeStep?.label ? ` · ${activeStep.label}` : ""}
                </span>
              </div>
              <div className="h-0.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                <div
                  className="h-full bg-[var(--accent)] transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Page body — driven by the route page. The Wizard's STEPS
          array is just metadata: slug + label + onNext. The previous
          `children ?? activeStep.render(ctx)` showed BOTH the page
          and the step component (or the step when the page returned
          null) and the two sources disagreed on what comes next,
          leaving the user stuck on an empty body. Render the page
          content only — the onboarding page files already import
          the step component, so the URL is the single source of
          truth.

          ``min-h-[420px]`` keeps the wizard body from collapsing
          when a step's content is short (the Done step is ~280px;
          the Org step's create-form is ~360px). Without a stable
          floor the entire layout jumped on every step transition
          (welcome → org was a visible +120px snap, done → welcome
          was a -80px snap) which the user described as
          "the screen size changes constantly". The value is the
          tallest non-Connect step; Connect / Wait render taller
          and the floor is just a no-op for them. */}
      <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-6 sm:py-8 min-h-[420px] flex flex-col">{children}</div>

      {/* Bottom navigation (only on non-complete steps). Sits below
          the body (no -mt-4) so it never overlaps the page content.
          ponytail: `sticky bottom-0` keeps the Back/Next row visible
          on short viewports (13" laptops, iOS keyboards) — the body
          above can scroll but the nav is anchored to the viewport's
          bottom edge. The translucent bg matches the body so the
          scroll content doesn't bleed through. */}
      {!isComplete && activeStep && (
        <div className="sticky bottom-0 z-10 mx-auto w-full max-w-3xl bg-[var(--bg-primary)]/95 backdrop-blur-sm border-t border-[var(--border-default)] px-6 py-3">
          <div className="flex items-center justify-between">
            <button
              onClick={onBack}
              disabled={activeIdx === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <div className="flex items-center gap-2">
              {activeStep.optional && (
                <button
                  onClick={onSkipStep}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]"
                >
                  <SkipForward className="w-4 h-4" />
                  Skip this step
                </button>
              )}
              <button
                onClick={onNext}
                disabled={busy}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {busy ? "Working…" : activeStep.id === "done" ? "Finish" : "Next"}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
