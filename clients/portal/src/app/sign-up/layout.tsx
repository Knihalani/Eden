import { AppClerkProvider } from "@/components/providers/app-clerk-provider";

export const metadata = { title: "Sign up · Eden" };

export default function SignUpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppClerkProvider>{children}</AppClerkProvider>;
}
