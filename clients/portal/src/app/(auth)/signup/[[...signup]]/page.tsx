import { SignUp } from "@clerk/nextjs";
import { AuthSplitLayout, AuthBrandPanel, ClerkAuthFallback } from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";
import { buildAuthClerkRedirectProps } from "@/lib/auth-redirect";

// Legacy /signup alias. next.config.ts 307s /signup → /sign-up, so
// this page is a belt-and-suspenders mirror of the canonical route
// (same chrome, copy, and redirects) if the redirect is ever bypassed.
// Cross-links use canonical /sign-in so we never bounce
// /signup → /login → /sign-in in a multi-hop loop.
//
// ClerkAuthFallback wraps the <SignUp /> component. If the Clerk
// SDK fails to mount, the fallback shows a designed empty state
// instead of a blank right column.
export default async function SignupPage({
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
            path="/signup"
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
