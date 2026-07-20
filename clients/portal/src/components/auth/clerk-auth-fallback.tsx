"use client";

/**
 * ClerkAuthFallback — renders the Clerk component, and if the
 * component fails to mount (e.g. the publishable key is missing or
 * the Clerk backend is unreachable) shows a designed empty state
 * instead of an empty right column.
 *
 * Three states:
 *
 * 1. ``loading`` — Clerk is still mounting. Quiet instrument-panel
 *    placeholders match the eventual form; they unmount the moment
 *    Clerk inserts real inputs (MutationObserver), not after a fixed
 *    delay — otherwise the skeleton sits on top of a loaded form.
 *
 * 2. ``ready`` — Clerk mounted; children only (no overlay).
 *
 * 3. ``failed`` — ``READY_TIMEOUT_MS`` passed with no Clerk content.
 *    Render the "Auth provider unavailable" card.
 */

import { useEffect, useRef, useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { AlertTriangle, ExternalLink, Mail } from "lucide-react";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

// Fail-closed budget if Clerk never inserts form controls. Healthy
// mounts usually resolve via MutationObserver well under 1s.
const READY_TIMEOUT_MS = 2500;

interface ClerkAuthFallbackProps {
  /** The Clerk component to render (e.g. <SignIn />, <SignUp />). */
  children: React.ReactNode;
  /** What the form is supposed to be — used in fallback copy. */
  formLabel: "sign-in" | "sign-up";
}

type MountState = "loading" | "ready" | "failed";

function clerkHasForm(root: HTMLElement | null): boolean {
  if (!root) return false;
  return Boolean(
    root.querySelector(
      "input, button, textarea, select, [data-clerk-component], iframe",
    ),
  );
}

export function ClerkAuthFallback({ children, formLabel }: ClerkAuthFallbackProps) {
  const clerk = useClerk();
  const cardRef = useRef<HTMLDivElement>(null);
  const [mountState, setMountState] = useState<MountState>("loading");

  useEffect(() => {
    const root = cardRef.current;
    if (!root) return;

    const markReady = () => {
      setMountState((prev) => (prev === "failed" ? prev : "ready"));
    };

    // Clerk may already have painted (fast cache / SPA nav).
    if (clerkHasForm(root) || clerk?.loaded) {
      markReady();
    }

    const observer = new MutationObserver(() => {
      if (clerkHasForm(root)) markReady();
    });
    observer.observe(root, { childList: true, subtree: true });

    // Poll briefly — Clerk sometimes mounts without mutating this
    // subtree (portal / shadow). Stop once ready or timed out.
    const poll = window.setInterval(() => {
      if (clerkHasForm(root) || clerk?.loaded) markReady();
    }, 100);

    const t = window.setTimeout(() => {
      window.clearInterval(poll);
      setMountState((prev) => {
        if (prev === "ready") return prev;
        return clerkHasForm(root) || clerk?.loaded ? "ready" : "failed";
      });
    }, READY_TIMEOUT_MS);

    return () => {
      observer.disconnect();
      window.clearInterval(poll);
      window.clearTimeout(t);
    };
  }, [clerk?.loaded]);

  if (mountState === "failed" || !clerk) {
    return (
      <div className="w-full max-w-md space-y-space-4">
        <div
          role="alert"
          className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-space-5"
        >
          <div className="flex items-start gap-space-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10">
              <AlertTriangle className="h-4 w-4 text-[var(--warning)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Auth provider unavailable
              </p>
              <p className="mt-space-1 text-sm leading-relaxed text-[var(--text-muted)]">
                We can&rsquo;t load the {formLabel === "sign-in" ? "sign-in" : "sign-up"} form
                right now. The auth service may be temporarily unreachable, or
                the deployment is missing a configuration value.
              </p>
              <div className="mt-space-4 flex flex-col gap-space-2 sm:flex-row sm:items-center">
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex min-h-11 items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-4 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                  Try again
                </button>
                <a
                  href="mailto:security@eden.dev?subject=Auth%20provider%20unavailable"
                  className="inline-flex min-h-11 items-center gap-space-2 text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)]"
                >
                  <Mail className="h-3.5 w-3.5" />
                  Email security@eden.dev
                </a>
              </div>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] overflow-hidden">
          <div className="flex items-center gap-space-2 px-space-4 py-space-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50">
            <span aria-hidden className="flex gap-space-2">
              <span className="w-2 h-2 rounded-full bg-[var(--text-faint)]" />
              <span className="w-2 h-2 rounded-full bg-[var(--text-faint)]" />
              <span className="w-2 h-2 rounded-full bg-[var(--text-faint)]" />
            </span>
            <span className="ml-space-1 text-2xs font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
              Meanwhile, try the SDK
            </span>
          </div>
          <div className="p-space-4 font-mono text-sm leading-relaxed text-[var(--text-secondary)]">
            <div className="text-[var(--text-faint)]"># install the SDK</div>
            <div className="mt-space-2">
              <span className="text-[var(--accent)]">$</span>{" "}
              <span className="text-[var(--text-primary)]">pip install eden-sdk</span>
            </div>
            <div className="text-[var(--text-faint)]"># create or join an org, then get an API key</div>
            <div className="mt-space-2 break-all">
              <span className="text-[var(--accent)]">$</span>{" "}
              <span className="text-[var(--text-primary)]">export EDEN_API_KEY=…</span>
            </div>
            <div className="mt-space-3 text-[var(--text-faint)]"># send your first trace</div>
            <div className="mt-space-2">
              <a
                href={DOCS_QUICKSTART_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-space-2 text-[var(--accent)] hover:text-[var(--accent-hover)]"
              >
                Docs quickstart
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={cardRef} className="relative w-full max-w-md min-h-[280px]">
      {children}
      {/* Unmount when ready — opacity-0 overlays still blocked clicks
          / looked like a stuck skeleton on top of the real form. */}
      {mountState === "loading" ? (
        <ClerkFormSkeleton formLabel={formLabel} />
      ) : null}
    </div>
  );
}

/**
 * Quiet instrument-panel placeholders while Clerk mounts.
 * ``pointer-events-none`` so bars never steal clicks if Clerk paints
 * underneath before we unmount.
 */
function ClerkFormSkeleton({
  formLabel,
}: {
  formLabel: "sign-in" | "sign-up";
}) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex flex-col gap-space-3 bg-[var(--bg-secondary)]"
    >
      <div className="h-10 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)]/80" />
      <div className="h-10 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)]/80" />
      <div className="mt-space-1 h-10 w-full rounded-md border border-[var(--accent)]/25 bg-[var(--accent)]/5" />
      <div className="mt-space-3 flex items-center gap-space-3 text-2xs font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
        <span className="h-px flex-1 bg-[var(--border-subtle)]" />
        or
        <span className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>
      <div className="h-10 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)]/60" />
      <div className="h-10 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)]/60" />
      <p className="mt-space-2 text-center text-2xs font-mono uppercase tracking-[0.2em] text-[var(--text-muted)]">
        {formLabel === "sign-in" ? "loading sign-in" : "loading sign-up"}
      </p>
    </div>
  );
}
