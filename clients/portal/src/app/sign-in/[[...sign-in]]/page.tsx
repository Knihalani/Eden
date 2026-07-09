import { SignIn } from "@clerk/nextjs";
import { AuthSplitLayout, AuthBrandPanel, ClerkAuthFallback } from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";

// Catch-all so Clerk's internal sub-flows (factor-one, verify-email,
// sso-callback, etc.) all resolve under /sign-in/*. The `path` prop
// tells Clerk to treat /sign-in as its base URL.
//
// We mirror the legacy (auth)/login/[[...login]]/page.tsx:
//   - AuthSplitLayout puts the brand panel on the left, the Clerk
//     form on the right.
//   - clerkAppearance (in clerk-theme.ts) maps our CSS variables onto
//     Clerk's theme tokens so the form inputs, buttons, and alerts
//     all inherit the dark palette.
// Two routes (legacy /login/* and new /sign-in/*) both render the
// same chrome — Clerk's own portal-style redirects use /sign-in by
// default, so this is the path most users will land on.
//
// ClerkAuthFallback wraps the <SignIn /> component. If the Clerk
// SDK fails to mount (missing publishable key, network blocked,
// backend outage), the fallback shows a designed empty state
// instead of a blank right column.
export default function SignInPage() {
  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <div className="w-full max-w-md space-y-6">
        {/* Branded eyebrow above the Clerk card so the screen reads
            as "Eden auth" rather than a generic Clerk form. The
            <SignIn /> component hides its own headerSubtitle via
            the appearance config in clerk-theme.ts. */}
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
            path="/sign-in"
            routing="path"
            signUpUrl="/sign-up"
            // Send signed-in users to the dashboard, not back to "/".
            // Without an explicit fallback Clerk sometimes resolves to
            // the current URL, which can leave a user who clicked "Sign
            // in" from /sign-up stuck on the auth card.
            fallbackRedirectUrl="/dashboard"
            appearance={clerkAppearance}
          />
        </ClerkAuthFallback>
      </div>
    </AuthSplitLayout>
  );
}
