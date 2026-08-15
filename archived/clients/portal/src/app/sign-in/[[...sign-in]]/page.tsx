import { SignIn } from "@clerk/nextjs";
import { AuthSplitLayout, ClerkAuthFallback } from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";
import { buildAuthClerkRedirectProps } from "@/lib/auth-redirect";

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
    <AuthSplitLayout>
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
    </AuthSplitLayout>
  );
}
