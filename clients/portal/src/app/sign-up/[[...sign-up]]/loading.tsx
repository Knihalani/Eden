import { Loader2 } from "lucide-react";
import { AuthSplitLayout, AuthBrandPanel } from "@/components/auth";

/**
 * Loading state for /sign-up/* — Clerk renders its own loading
 * UI on top of this once mounted, but the route-level fallback
 * prevents the page from flashing unstyled content while the
 * catch-all and Clerk client initialise.
 */
export default function Loading() {
  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <div
        className="flex items-center justify-center py-space-8"
        aria-busy="true"
        aria-live="polite"
      >
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
      </div>
    </AuthSplitLayout>
  );
}
