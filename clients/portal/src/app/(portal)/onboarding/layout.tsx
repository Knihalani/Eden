/**
 * /onboarding/* — wizard chrome
 *
 * Minimal layout: no sidebar, no top nav. Just a centered card with a
 * progress bar and an Eden wordmark. The wizard is rendered inside
 * the (portal) route group so auth still applies, but the
 * PortalLayout is bypassed so users aren't tempted to click around
 * before finishing setup.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight, Sparkles, Check } from "lucide-react";

const STEPS: { slug: string; label: string }[] = [
  { slug: "/onboarding", label: "Welcome" },
  { slug: "/onboarding/org", label: "Organisation" },
  { slug: "/onboarding/install", label: "Install SDK" },
  { slug: "/onboarding/connect", label: "Connect GitHub" },
  { slug: "/onboarding/wait", label: "Open PR" },
  { slug: "/onboarding/done", label: "Done" },
];

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/onboarding";
  const router = useRouter();

  // Joined-org users skip "connect" + "wait" — the progress bar
  // hides them in that path. The page itself enforces the skip.
  const [skipRepo, setSkipRepo] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setSkipRepo(window.localStorage.getItem("eden:onboarding:skipRepo") === "1");
  }, []);

  const visibleSteps = useMemo(() => {
    if (!skipRepo) return STEPS;
    return STEPS.filter((s) => s.slug !== "/onboarding/connect" && s.slug !== "/onboarding/wait");
  }, [skipRepo]);

  const activeIdx = visibleSteps.findIndex((s) => pathname === s.slug);
  const progress = activeIdx >= 0 ? ((activeIdx + 1) / visibleSteps.length) * 100 : 0;

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Top bar */}
      <div className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-[var(--accent)]" />
            <span className="font-semibold tracking-tight">Eden</span>
            <span className="text-xs text-[var(--text-muted)]">— onboarding</span>
          </div>
          <button
            onClick={() => {
              if (typeof window !== "undefined") {
                window.localStorage.removeItem("eden:onboarding:skipRepo");
              }
              router.push("/dashboard");
            }}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Skip to dashboard →
          </button>
        </div>
      </div>

      {/* Progress strip */}
      <div className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-2">
        <div className="mx-auto max-w-3xl">
          <div className="mb-2 flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>Step {Math.max(activeIdx + 1, 1)} of {visibleSteps.length}</span>
            <span>{visibleSteps[activeIdx]?.label ?? ""}</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
            <div
              className="h-full bg-[var(--accent)] transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="mt-3 flex items-center gap-1 overflow-x-auto">
            {visibleSteps.map((s, i) => {
              const done = i < activeIdx;
              const active = i === activeIdx;
              return (
                <div
                  key={s.slug}
                  className="flex items-center gap-1 text-xs"
                >
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                      done
                        ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-primary)]"
                        : active
                        ? "border-[var(--accent)] text-[var(--accent)]"
                        : "border-[var(--border-default)] text-[var(--text-muted)]"
                    }`}
                  >
                    {done ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <span
                    className={`whitespace-nowrap ${
                      active
                        ? "font-medium text-[var(--text-primary)]"
                        : "text-[var(--text-muted)]"
                    }`}
                  >
                    {s.label}
                  </span>
                  {i < visibleSteps.length - 1 && (
                    <ArrowRight className="mx-1 h-3 w-3 text-[var(--text-muted)]" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Page body */}
      <div className="mx-auto max-w-3xl px-6 py-10">{children}</div>
    </div>
  );
}
