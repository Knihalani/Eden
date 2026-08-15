import { AuthBrandPanel } from "@/components/auth/auth-brand-panel";

interface AuthSplitLayoutProps {
  children: React.ReactNode;
}

/**
 * Desktop: ~50/50 brand panel + form column.
 * Mobile: compact brand strip stacked above the form.
 * Card chrome is owned by ClerkAuthFallback / AuthFormCard — not here
 * (avoids double .auth-card nesting on sign-in/up).
 */
export function AuthSplitLayout({ children }: AuthSplitLayoutProps) {
  return (
    <div className="auth-shell grid min-h-dvh grid-cols-1 bg-[var(--bg)] lg:grid-cols-2">
      <AuthBrandPanel />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-8 sm:px-8 lg:py-16">
        <div className="w-full max-w-[400px]">{children}</div>
      </div>
    </div>
  );
}
