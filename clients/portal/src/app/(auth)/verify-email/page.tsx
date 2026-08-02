import { Suspense } from "react";
import { VerifyEmailPanel } from "./verify-email-panel";

export const metadata = { title: "Verify email · Eden" };

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailPanel />
    </Suspense>
  );
}
