"use client";

/**
 * Legacy /reset-password — Clerk owns the reset flow via
 * ``/sign-in``. Old token links land here; we point users at Clerk
 * instead of the retired native API.
 */

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, KeyRound } from "lucide-react";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

export default function ResetPasswordPage() {
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
        title="Use Clerk to reset your password"
        subtitle="Native reset links are retired. Sign in with Clerk and use Forgot password? instead."
      >
        <div className="space-y-5">
          <div
            role="status"
            aria-live="polite"
            className="bg-[var(--accent-faint)] text-[var(--text-secondary)] text-sm px-4 py-3 rounded-xl flex items-start gap-2.5 border border-[var(--accent)]/20"
          >
            <KeyRound className="w-4 h-4 flex-shrink-0 mt-0.5 text-[var(--accent)]" aria-hidden="true" />
            <span>
              If you opened an old reset email, request a new link from the
              Clerk sign-in screen. Redirecting you there…
            </span>
          </div>
          <Link
            href="/sign-in"
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90"
          >
            Continue to sign in
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Link>
        </div>
      </AuthFormCard>
    </AuthSplitLayout>
  );
}
