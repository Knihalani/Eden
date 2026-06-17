import { SignIn } from "@clerk/nextjs";
import { AuthSplitLayout, AuthBrandPanel } from "@/components/auth";
import { clerkAppearance } from "@/components/auth/clerk-theme";

// Catch-all so Clerk's internal sub-flows (factor-one, verify-email,
// sso-callback, etc.) all resolve under /login/*. The `path` prop
// tells Clerk to treat /login as its base URL.
//
// The page wraps Clerk's <SignIn /> in our original split-layout
// chrome (brand panel left, form card right) so the auth screen
// matches the rest of the dark-terminal portal. Clerk's appearance
// API (in clerk-theme.ts) maps our CSS variables onto Clerk's theme
// tokens so the form inputs, buttons, and alerts all inherit the
// dark palette instead of Clerk's default light theme.
export default function LoginPage() {
  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <SignIn
        path="/login"
        routing="path"
        signUpUrl="/signup"
        appearance={clerkAppearance}
      />
    </AuthSplitLayout>
  );
}