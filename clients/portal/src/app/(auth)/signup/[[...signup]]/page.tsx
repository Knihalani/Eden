import { SignUp } from "@clerk/nextjs";
import {
  AuthSplitLayout,
  AuthBrandPanel,
  AuthPageIntro,
  ClerkAuthFallback,
} from "@/components/auth";
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
      <div className="w-full max-w-md space-y-space-5" data-wave11-auth="sign-up">
        <AuthPageIntro
          eyebrow="Get started"
          title="Create your account"
          description="Create or join an organization first, then take the product tour, create an API key, and send your first trace."
        />
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
