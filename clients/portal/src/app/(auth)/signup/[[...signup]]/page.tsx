import { SignUp } from "@clerk/nextjs";
import { AuthSplitLayout, AuthBrandPanel } from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";

// Catch-all so Clerk's internal sub-flows (factor-one, verify-email,
// sso-callback, etc.) all resolve under /signup/*. The `path` prop
// tells Clerk to treat /signup as its base URL.
//
// Same chrome + theme as /login — see (auth)/login/[[...login]]/page.tsx
// for the rationale.
export default function SignupPage() {
  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <div className="w-full max-w-md space-y-6">
        {/* Eyebrow above the Clerk card so users land in a
            branded context instead of Clerk's default heading. */}
        <div className="text-center space-y-1.5">
          <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
            Get started
          </p>
          <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
            Create your account
          </h1>
          <p className="text-sm text-[var(--text-muted)]">
            Spin up an Eden workspace in under a minute
          </p>
        </div>
        <SignUp
          path="/signup"
          routing="path"
          signInUrl="/login"
          // After a successful signup, land on the onboarding wizard
          // instead of the dashboard. New users always need the
          // org step; routing them straight to /onboarding gets
          // them to a productive state in one click. Mirrors the
          // /sign-up route so both paths behave identically.
          fallbackRedirectUrl="/onboarding"
          signInForceRedirectUrl="/dashboard"
          appearance={clerkAppearance}
        />
      </div>
    </AuthSplitLayout>
  );
}
