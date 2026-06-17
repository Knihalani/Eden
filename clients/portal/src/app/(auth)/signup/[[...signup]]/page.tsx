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
      <SignUp
        path="/signup"
        routing="path"
        signInUrl="/login"
        appearance={clerkAppearance}
      />
    </AuthSplitLayout>
  );
}