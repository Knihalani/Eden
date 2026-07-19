import { SignUp } from "@clerk/nextjs";
import { AuthSplitLayout, AuthBrandPanel, ClerkAuthFallback } from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";

// Catch-all so Clerk's internal sub-flows (factor-one, verify-email,
// sso-callback, etc.) all resolve under /sign-up/*. The `path` prop
// tells Clerk to treat /sign-up as its base URL.
//
// Mirrors the legacy (auth)/signup/[[...signup]]/page.tsx — same
// chrome + theme, just on the Clerk-default path.
//
// ClerkAuthFallback wraps the <SignUp /> component. If the Clerk
// SDK fails to mount (missing publishable key, network blocked,
// backend outage), the fallback shows a designed empty state
// instead of a blank right column.
export default function SignUpPage() {
  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <div className="w-full max-w-md space-y-6">
        {/* Branded eyebrow above the Clerk card so the screen reads
            as "Eden auth" rather than a generic Clerk form. The
            <SignUp /> component hides its own header via
            the appearance config in clerk-theme.ts. */}
        <div className="text-center space-y-1.5">
          <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
            Get started
          </p>
          <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
            Create your account
          </h1>
          <p className="text-sm text-[var(--text-muted)]">
            Then take the product tour, create an API key, and send your first
            trace from the docs quickstart.
          </p>
        </div>
        <ClerkAuthFallback formLabel="sign-up">
          <SignUp
            path="/sign-up"
            routing="path"
            signInUrl="/sign-in"
            // After signup: dashboard opens the product tour overlay
            // (welcome → API keys → install → traces → finish / docs).
            fallbackRedirectUrl="/dashboard?onboarding=1"
            signInForceRedirectUrl="/dashboard"
            appearance={clerkAppearance}
          />
        </ClerkAuthFallback>
      </div>
    </AuthSplitLayout>
  );
}
