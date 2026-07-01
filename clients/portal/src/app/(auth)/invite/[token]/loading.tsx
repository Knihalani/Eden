import { Loader2 } from "lucide-react";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

/**
 * Loading state for /invite/[token] — the page itself shows a
 * spinner while verifying the token, but the route-level
 * fallback ensures we don't flash a blank form during the
 * first server-render pass.
 */
export default function Loading() {
  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <AuthFormCard title="Verifying invitation" subtitle="One moment…">
        <div
          className="flex items-center justify-center py-8"
          aria-busy="true"
          aria-live="polite"
        >
          <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        </div>
      </AuthFormCard>
    </AuthSplitLayout>
  );
}
