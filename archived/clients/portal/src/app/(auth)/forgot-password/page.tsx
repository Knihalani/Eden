import { AuthMessageCard } from "@/components/auth";

export const metadata = { title: "Forgot password · Eden" };

export default function ForgotPasswordPage() {
  return (
    <AuthMessageCard
      title="Reset your password"
      body="Use Sign in → Forgot password. Clerk sends the reset email and walks you through setting a new password there — this page does not collect credentials."
      ctaHref="/sign-in"
      ctaLabel="Go to sign in"
    />
  );
}
