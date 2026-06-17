// The (auth) route group is a pass-through now that Clerk's middleware
// in `src/proxy.ts` handles gating. The marketing / portal layouts are
// siblings under the same group, so we don't need a custom guard here.
//
// Pages in this group (login, signup, forgot-password, reset-password,
// invite) decide their own chrome — for example the Clerk
// `<SignIn />` / `<SignUp />` components render their own UI.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}