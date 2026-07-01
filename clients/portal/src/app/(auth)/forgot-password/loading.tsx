import { Loader2 } from "lucide-react";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

/**
 * Loading state for /forgot-password — Clerk's own loading UI
 * doesn't apply here (this is a native form), so we mirror the
 * auth split-layout and render a centered spinner inside the
 * form card so the layout doesn't shift when the page resolves.
 */
export default function Loading() {
  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <AuthFormCard title="Reset password" subtitle="Loading…">
        <div className="flex items-center justify-center py-8" aria-busy="true" aria-live="polite">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        </div>
      </AuthFormCard>
    </AuthSplitLayout>
  );
}
