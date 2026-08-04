import { AppClerkProvider } from "@/components/providers/app-clerk-provider";

export const metadata = { title: "Sign in · Eden" };

export default function SignInLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppClerkProvider>{children}</AppClerkProvider>;
}
