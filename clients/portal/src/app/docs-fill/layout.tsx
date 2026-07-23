import { AppClerkProvider } from "@/components/providers/app-clerk-provider";

/** Docs Fill-in needs Clerk session tokens — keep outside marketing tree. */
export default function DocsFillLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppClerkProvider>{children}</AppClerkProvider>;
}
