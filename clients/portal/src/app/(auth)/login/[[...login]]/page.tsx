import { SignIn } from "@clerk/nextjs";

// Catch-all so Clerk's internal sub-flows (factor-one, verify-email,
// sso-callback, etc.) all resolve under /login/*. The `path` prop
// tells Clerk to treat /login as its base URL.
export default function LoginPage() {
  return <SignIn path="/login" routing="path" />;
}