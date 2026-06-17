import { SignUp } from "@clerk/nextjs";

// Catch-all so Clerk's internal sub-flows (factor-one, verify-email,
// sso-callback, etc.) all resolve under /signup/*. The `path` prop
// tells Clerk to treat /signup as its base URL.
export default function SignupPage() {
  return <SignUp path="/signup" routing="path" />;
}