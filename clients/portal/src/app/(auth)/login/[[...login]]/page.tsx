import { SignIn } from "@clerk/nextjs";
import {
  AuthSplitLayout,
  AuthBrandPanel,
  AuthPageIntro,
  ClerkAuthFallback,
} from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";
import { buildAuthClerkRedirectProps } from "@/lib/auth-redirect";

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
export default async function LoginPage({
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
      <div className="w-full max-w-md space-y-space-5" data-wave11-auth="sign-in">
        <AuthPageIntro
          eyebrow="Account access"
          title="Welcome back"
          description="Sign in to create or join an org, then get an API key and send your first trace."
        />
        <ClerkAuthFallback formLabel="sign-in">
          <SignIn
            path="/login"
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
