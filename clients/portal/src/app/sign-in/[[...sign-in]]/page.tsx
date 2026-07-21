import { SignIn } from "@clerk/nextjs";
import { AuthSplitLayout, AuthBrandPanel, ClerkAuthFallback } from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";
import { buildAuthClerkRedirectProps } from "@/lib/auth-redirect";

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
//
// ``?redirect_url=`` is sanitized and preferred over the dashboard
// fallback. Cross-link to sign-up uses *fallback* (not force) so the
// return URL survives when the user flips forms. Orgless sessions
// still hit /dashboard first; portal chrome routes them to
// /settings?tab=org when needed.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.redirect_url)
    ? params.redirect_url[0]
    : params.redirect_url;
  const redirects = buildAuthClerkRedirectProps(raw, "sign-in");

  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <div className="w-full max-w-md space-y-space-5">
        {/* Branded eyebrow above the Clerk card so the screen reads
            as "Eden auth" rather than a generic Clerk form. The
            <SignIn /> component hides its own header via
            the appearance config in clerk-theme.ts. */}
        <div className="text-center space-y-space-2">
          <p className="text-xs font-mono font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
            Account access
          </p>
          <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
            Welcome back
          </h1>
          <p className="text-sm text-[var(--text-muted)]">
            Sign in to create or join an org, then get an API key and send your
            first trace.
          </p>
        </div>
        <ClerkAuthFallback formLabel="sign-in">
          <SignIn
            path="/sign-in"
            routing="path"
            signUpUrl={redirects.crossLinkUrl}
            {...(redirects.forceRedirectUrl
              ? { forceRedirectUrl: redirects.forceRedirectUrl }
              : {})}
            fallbackRedirectUrl={redirects.fallbackRedirectUrl}
            signUpFallbackRedirectUrl={redirects.crossLinkFallbackRedirectUrl}
            appearance={clerkAppearance}
          />
        </ClerkAuthFallback>
      </div>
    </AuthSplitLayout>
  );
}
