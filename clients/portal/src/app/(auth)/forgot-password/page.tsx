"use client";

/**
 * Legacy /forgot-password — Clerk handles password reset inside
 * ``/sign-in``. This page redirects there with a short note so old
 * bookmarks / emails still land somewhere useful.
 */

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, KeyRound } from "lucide-react";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

export default function ForgotPasswordPage() {
  const router = useRouter();

  useEffect(() => {
    const t = window.setTimeout(() => {
      router.replace("/sign-in");
    }, 2500);
    return () => window.clearTimeout(t);
  }, [router]);

  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <AuthFormCard
        title="Password reset moved"
        subtitle="Eden uses Clerk for account access. Reset your password from the sign-in screen."
      >
        <div className="space-y-5">
          <div
            role="status"
            aria-live="polite"
            className="bg-[var(--accent-faint)] text-[var(--text-secondary)] text-sm px-4 py-3 rounded-xl flex items-start gap-2.5 border border-[var(--accent)]/20"
          >
            <KeyRound className="w-4 h-4 flex-shrink-0 mt-0.5 text-[var(--accent)]" aria-hidden="true" />
            <span>
              Click <strong className="text-[var(--text-primary)]">Forgot password?</strong> on
              the Clerk sign-in form to receive a reset link. Redirecting you there…
            </span>
          </div>
          <Link
            href="/sign-in"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90"
          >
            Continue to sign in
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Link>
        </div>
      </AuthFormCard>
    </AuthSplitLayout>
  );
}
