import { Loader2 } from "lucide-react";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

/**
 * Loading state for /forgot-password — redirect stub while Clerk owns
 * password reset on /sign-in.
 */
export default function Loading() {
  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <AuthFormCard title="Password reset moved" subtitle="Opening sign-in…">
        <div className="flex items-center justify-center py-8" aria-busy="true" aria-live="polite">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        </div>
      </AuthFormCard>
    </AuthSplitLayout>
  );
}
