import { SignUp } from "@clerk/nextjs";
import { AuthSplitLayout, AuthBrandPanel } from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";

// Catch-all so Clerk's internal sub-flows (factor-one, verify-email,
// sso-callback, etc.) all resolve under /sign-up/*. The `path` prop
// tells Clerk to treat /sign-up as its base URL.
//
// Mirrors the legacy (auth)/signup/[[...signup]]/page.tsx — same
// chrome + theme, just on the Clerk-default path.
export default function SignUpPage() {
  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <SignUp
        path="/sign-up"
        routing="path"
        signInUrl="/sign-in"
        // After a successful signup, land on the onboarding wizard
        // instead of the dashboard. Without this, Clerk's default
        // fallback resolves to the current URL ("/sign-up") which
        // re-renders the auth card and feels like the site hung.
        // New users always need the org step; routing them straight
        // to /onboarding gets them to a productive state in one click.
        fallbackRedirectUrl="/onboarding"
        signInForceRedirectUrl="/dashboard"
        appearance={clerkAppearance}
      />
    </AuthSplitLayout>
  );
}