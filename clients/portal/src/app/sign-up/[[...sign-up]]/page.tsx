import { SignUp } from "@clerk/nextjs";
import { AuthSplitLayout, AuthBrandPanel, ClerkAuthFallback } from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";
import { buildAuthClerkRedirectProps } from "@/lib/auth-redirect";

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
//
// ``?redirect_url=`` is sanitized and preferred over the onboarding
// fallback. Cross-link to sign-in uses *fallback* (not force) so the
// return URL survives when the user flips forms.
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.redirect_url)
    ? params.redirect_url[0]
    : params.redirect_url;
  const redirects = buildAuthClerkRedirectProps(raw, "sign-up");

  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <div className="w-full max-w-md space-y-space-5">
        {/* Branded eyebrow above the Clerk card so the screen reads
            as "Eden auth" rather than a generic Clerk form. The
            <SignUp /> component hides its own header via
            the appearance config in clerk-theme.ts. */}
        <div className="text-center space-y-space-2">
          <p className="text-2xs font-mono font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
            Get started
          </p>
          <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
            Create your account
          </h1>
          <p className="text-sm text-[var(--text-muted)]">
            Create or join an organization first, then take the product tour,
            create an API key, and send your first trace.
          </p>
        </div>
        <ClerkAuthFallback formLabel="sign-up">
          <SignUp
            path="/sign-up"
            routing="path"
            signInUrl={redirects.crossLinkUrl}
            {...(redirects.forceRedirectUrl
              ? { forceRedirectUrl: redirects.forceRedirectUrl }
              : {})}
            fallbackRedirectUrl={redirects.fallbackRedirectUrl}
            signInFallbackRedirectUrl={redirects.crossLinkFallbackRedirectUrl}
            appearance={clerkAppearance}
          />
        </ClerkAuthFallback>
      </div>
    </AuthSplitLayout>
  );
}
