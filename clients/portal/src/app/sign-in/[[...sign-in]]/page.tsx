import { SignIn } from "@clerk/nextjs";
import { AuthSplitLayout, AuthBrandPanel } from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";

// Catch-all so Clerk's internal sub-flows (factor-one, verify-email,
// sso-callback, etc.) all resolve under /sign-in/*. The `path` prop
// tells Clerk to treat /sign-in as its base URL.
//
// We mirror the legacy (auth)/login/[[...login]]/page.tsx exactly:
//   - AuthSplitLayout puts the brand panel on the left, the Clerk
//     form on the right.
//   - clerkAppearance (in clerk-theme.ts) maps our CSS variables onto
//     Clerk's theme tokens so the form inputs, buttons, and alerts
//     all inherit the dark palette.
// Two routes (legacy /login/* and new /sign-in/*) both render the
// same chrome — Clerk's own portal-style redirects use /sign-in by
// default, so this is the path most users will land on.
export default function SignInPage() {
  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <SignIn
        path="/sign-in"
        routing="path"
        signUpUrl="/sign-up"
        // Send signed-in users to the dashboard, not back to "/".
        // Without an explicit fallback Clerk sometimes resolves to
        // the current URL, which can leave a user who clicked "Sign
        // in" from /sign-up stuck on the auth card.
        signInFallbackRedirectUrl="/dashboard"
        appearance={clerkAppearance}
      />
    </AuthSplitLayout>
  );
}