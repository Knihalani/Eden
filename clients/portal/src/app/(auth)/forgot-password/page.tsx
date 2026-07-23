import Link from "next/link";
import { AuthSplitLayout } from "@/components/auth";

export default function ForgotPasswordPage() {
  return (
    <AuthSplitLayout>
      <div className="auth-card text-center">
        <h1 className="type-title !text-[1.0625rem]">Reset password</h1>
        <p className="type-body mt-2">
          Use the sign-in form to reset your password.
        </p>
        <Link href="/sign-in" className="ds-btn ds-btn-primary mt-6 inline-flex px-4">
          Back to sign in
        </Link>
      </div>
    </AuthSplitLayout>
  );
}
