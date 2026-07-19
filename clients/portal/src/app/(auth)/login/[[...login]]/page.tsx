import { SignIn } from "@clerk/nextjs";
import { AuthSplitLayout, AuthBrandPanel, ClerkAuthFallback } from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";

// Catch-all so Clerk's internal sub-flows (factor-one, verify-email,
// sso-callback, etc.) all resolve under /login/*. The `path` prop
// tells Clerk to treat /login as its base URL.
//
// Legacy /login alias. next.config.ts 307s /login → /sign-in.
// Cross-links use canonical /sign-up so we never bounce
// /login → /signup → /sign-up in a multi-hop loop.
//
// ClerkAuthFallback wraps the <SignIn /> component. If the Clerk
// SDK fails to mount (missing publishable key, network blocked,
// backend outage), the fallback shows a designed empty state
// instead of a blank right column.
export default function LoginPage() {
  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <div className="w-full max-w-md space-y-6">
        {/* Eyebrow above the Clerk card so users land in a
            branded context instead of Clerk's default heading. */}
        <div className="text-center space-y-1.5">
          <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
            Account access
          </p>
          <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
            Welcome back
          </h1>
          <p className="text-sm text-[var(--text-muted)]">
            Sign in to your Eden workspace
          </p>
        </div>
        <ClerkAuthFallback formLabel="sign-in">
          <SignIn
            path="/login"
            routing="path"
            signUpUrl="/sign-up"
            // Send signed-in users to the dashboard, not back to "/".
            // Without an explicit fallback Clerk sometimes resolves to
            // the current URL, which can leave a user who clicked
            // "Sign in" from /signup stuck on the auth card. Mirrors
            // the /sign-in route so both paths behave identically.
            fallbackRedirectUrl="/dashboard"
            signUpForceRedirectUrl="/dashboard?onboarding=1"
            appearance={clerkAppearance}
          />
        </ClerkAuthFallback>
      </div>
    </AuthSplitLayout>
  );
}
