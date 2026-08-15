import { AppClerkProvider } from "@/components/providers/app-clerk-provider";

// Auth chrome (forgot / reset / invite) needs Clerk for session links.
// Sign-in / sign-up live outside this group and have their own layouts.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <AppClerkProvider>{children}</AppClerkProvider>;
}
