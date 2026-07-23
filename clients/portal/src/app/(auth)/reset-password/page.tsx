import { AuthMessageCard } from "@/components/auth";

export const metadata = { title: "Reset password · Eden" };

export default function ResetPasswordPage() {
  return (
    <AuthMessageCard
      title="Password reset"
      body="If you followed a reset link, finish the flow from Sign in → Forgot password. This page does not accept tokens on its own."
      ctaHref="/sign-in"
      ctaLabel="Go to sign in"
    />
  );
}
