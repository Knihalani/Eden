"use client";

/**
 * ClerkAuthFallback — renders the Clerk component, and if the
 * component fails to mount (e.g. the publishable key is missing or
 * the Clerk backend is unreachable) shows a designed empty state
 * instead of an empty right column.
 *
 * Why this exists: a missing ``NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY``
 * in production makes ``<SignIn />`` and ``<SignUp />`` render
 * nothing at all. A user who clicks "Sign in" from the marketing
 * page would land on a half-page with only a heading — which
 * looks like a broken product, not a config error. This component
 * uses Clerk's own ``useClerk()`` hook: when the SDK is initialised
 * the hook resolves; when it's not, the hook throws or returns
 * ``null`` and we fall through to the empty state.
 *
 * Three states:
 *
 * 1. ``loading`` — Clerk is still mounting (the SDK takes ~600ms
 *    on a healthy network). We render a skeleton that matches the
 *    shape of the eventual form: two input fields and a primary
 *    button. The skeleton is animated with a slow shimmer so the
 *    user reads it as "loading", not "broken".
 *
 * 2. ``ready`` — Clerk mounted; pass the children through.
 *
 * 3. ``failed`` — the ``READY_TIMEOUT_MS`` deadline passed and the
 *    root has no Clerk content. Render the "Auth provider
 *    unavailable" card so the user has a fallback path (mailto +
 *    status page).
 *
 * Detection: ``useClerk()`` is the canonical Clerk readiness
 * signal. We combine it with a DOM-read of the Clerk card via a
 * ref to catch the "hook resolved but form not mounted" case
 * (e.g. browser blocked Clerk's CDN). The skeleton is shown
 * between mount and either resolution.
 */

import { useEffect, useRef, useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { AlertTriangle, Mail, ExternalLink } from "lucide-react";

// Clerk's own loading budget is ~600ms on a healthy network. We
// give it 2.5s before assuming the SDK didn't mount. The skeleton
// bridges this gap so the user sees an in-progress form, not a
// half-page with a heading and no form.
const READY_TIMEOUT_MS = 2500;

interface ClerkAuthFallbackProps {
  /** The Clerk component to render (e.g. <SignIn />, <SignUp />). */
  children: React.ReactNode;
  /** What the form is supposed to be — used in fallback copy. */
  formLabel: "sign-in" | "sign-up";
}

type MountState = "loading" | "ready" | "failed";

export function ClerkAuthFallback({ children, formLabel }: ClerkAuthFallbackProps) {
  const clerk = useClerk();
  const cardRef = useRef<HTMLDivElement>(null);
  const [mountState, setMountState] = useState<MountState>("loading");

  useEffect(() => {
    // If Clerk's hook never resolved (publishable key missing, SDK
    // import failed), we never leave the loading state. Force a
    // decision at READY_TIMEOUT_MS so the user sees the fallback
    // rather than an infinite skeleton.
    const t = window.setTimeout(() => {
      const root = cardRef.current;
      if (!root) {
        setMountState("failed");
        return;
      }
      // Clerk renders its form into a child div. If the root is
      // empty (no inputs, no buttons), Clerk didn't mount.
      const hasContent = root.querySelector("input, button, [data-clerk-component]");
      setMountState(hasContent ? "ready" : "failed");
    }, READY_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, []);

  if (mountState === "failed" || !clerk) {
    // Fallback: explain the outage AND give the user something
    // useful to do while they wait. The CLI install mock is the
    // same one the marketing home page leads with — it lets a
    // developer who already knows Eden try the SDK even if the
    // hosted UI is down, and fills the right column with the
    // same visual rhythm the rest of the portal uses.
    return (
      <div className="w-full max-w-md space-y-4">
        <div
          role="alert"
          className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-6"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10">
              <AlertTriangle className="h-4 w-4 text-[var(--warning)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Auth provider unavailable
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
                We can&rsquo;t load the {formLabel === "sign-in" ? "sign-in" : "sign-up"} form
                right now. The auth service may be temporarily unreachable, or
                the deployment is missing a configuration value.
              </p>
              <div className="mt-4 flex flex-col gap-2">
                <a
                  href="mailto:security@eden.dev?subject=Auth%20provider%20unavailable"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)]"
                >
                  <Mail className="h-3.5 w-3.5" />
                  Email security@eden.dev
                </a>
                <a
                  href="https://status.edenobservability.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  Check service status
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          </div>
        </div>
        {/* CLI install — gives the user something to do and fills
            the right column with brand-consistent content instead
            of dead space. The micro-label + 3 install lines
            mirror the marketing home terminal mock. */}
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50">
            <span aria-hidden className="flex gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--text-faint)]" />
              <span className="w-2 h-2 rounded-full bg-[var(--text-faint)]" />
              <span className="w-2 h-2 rounded-full bg-[var(--text-faint)]" />
            </span>
            <span className="ml-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
              Meanwhile, try the CLI
            </span>
          </div>
          <div className="p-4 font-mono text-[13px] leading-relaxed text-[var(--text-secondary)]">
            <div className="text-[var(--text-faint)]"># install the SDK</div>
            <div className="mt-1.5">
              <span className="text-[var(--accent)]">$</span>{" "}
              <span className="text-[var(--text-primary)]">pip install eden-sdk</span>
            </div>
            <div className="mt-3 text-[var(--text-faint)]"># point your OpenAI client at the gateway</div>
            <div className="mt-1.5 break-all">
              <span className="text-[var(--accent)]">$</span>{" "}
              <span className="text-[var(--text-primary)]">
                export OPENAI_BASE_URL=https://api.eden.dev/v1/proxy
              </span>
            </div>
            <div className="mt-3 text-[var(--text-faint)]"># review a PR-suggestion</div>
            <div className="mt-1.5">
              <span className="text-[var(--accent)]">$</span>{" "}
              <span className="text-[var(--text-primary)]">open eden://pr-suggestions</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={cardRef} className="relative w-full max-w-md min-h-[280px]">
      {/*
       * Render the Clerk children unconditionally so they can
       * mount as soon as Clerk is ready. While they mount, the
       * skeleton sits behind/over them. Once Clerk inserts
       * inputs / buttons into the ref'd div, our timer fires
       * and flips mountState to "ready" — we then hide the
       * skeleton via CSS by adding the `clerk-mounted` class to
       * a sibling. Keeping the skeleton in the DOM (rather than
       * conditionally rendering it) avoids a layout shift when
       * the form mounts.
       */}
      {children}
      <ClerkFormSkeleton visible={mountState === "loading"} formLabel={formLabel} />
    </div>
  );
}

/**
 * Skeleton placeholder that mirrors the shape of a Clerk sign-in
 * form: two stacked inputs, a primary button, then a row of
 * identity-provider buttons. The bars pulse with a slow
 * shimmer so the user reads it as "loading", not "broken".
 *
 * ``pointer-events-none`` so the bars never intercept clicks
 * meant for the Clerk form once it mounts. ``aria-hidden`` so
 * the skeleton doesn't pollute the accessibility tree.
 *
 * Position: absolutely positioned over the same flex container
 * the Clerk form mounts into. ``opacity-0`` transition means
 * the cross-fade is gentle (~150ms) rather than a hard swap.
 */
function ClerkFormSkeleton({
  visible,
  formLabel,
}: {
  visible: boolean;
  formLabel: "sign-in" | "sign-up";
}) {
  return (
    <div
      aria-hidden="true"
      className={
        "pointer-events-none absolute inset-0 flex flex-col gap-3 transition-opacity duration-200 motion-reduce:transition-none " +
        (visible ? "opacity-100" : "opacity-0")
      }
      inert={!visible}
    >
      {/* Quiet instrument-panel placeholders — static opacity, no
       * shimmer cascade. Matches portal LP-19 auth chrome. */}
      <div className="h-10 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)]/80" />
      <div className="h-10 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)]/80" />
      <div className="mt-1 h-10 w-full rounded-md border border-[var(--accent)]/25 bg-[var(--accent)]/5" />
      <div className="mt-3 flex items-center gap-3 text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
        <span className="h-px flex-1 bg-[var(--border-subtle)]" />
        or
        <span className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>
      <div className="h-10 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)]/60" />
      <div className="h-10 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)]/60" />
      <p className="mt-2 text-center text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--text-muted)]">
        {formLabel === "sign-in" ? "sign in" : "sign up"}
      </p>
    </div>
  );
}
