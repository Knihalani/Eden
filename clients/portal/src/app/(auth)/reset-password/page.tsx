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
import { Button } from "@/components/ui/button";

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
      <div data-wave11-auth="reset-password">
      <AuthFormCard
        title="Use Clerk to reset your password"
        subtitle="Native reset links are retired. Sign in with Clerk and use Forgot password? instead."
      >
        <div className="space-y-space-5">
          <div
            role="status"
            aria-live="polite"
            className="bg-[var(--accent-faint)] text-[var(--text-secondary)] text-sm px-space-4 py-space-3 rounded-xl flex items-start gap-space-3 border border-[var(--accent)]/20"
          >
            <KeyRound className="w-4 h-4 flex-shrink-0 mt-0.5 text-[var(--accent)]" aria-hidden="true" />
            <span>
              If you opened an old reset email, request a new link from the
              Clerk sign-in screen. Redirecting you there…
            </span>
          </div>
          <Button asChild className="min-h-11">
            <Link href="/sign-in">
              Continue to sign in
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </AuthFormCard>
      </div>
    </AuthSplitLayout>
  );
}
