import { AppClerkProvider } from "@/components/providers/app-clerk-provider";

export default function SignUpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppClerkProvider>{children}</AppClerkProvider>;
}
