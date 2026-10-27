import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AccountFrame } from "../account/frame";
import { SEE_PENDING, signedInDest } from "../account/home";
import { SignInForm } from "./form";

export const metadata = {
  title: "Sign in — Eden",
};

export default async function SignInPage() {
  const dest = signedInDest(await auth(SEE_PENDING));
  if (dest) redirect(dest);

  return (
    <AccountFrame other="signup">
      <Suspense>
        <SignInForm />
      </Suspense>
    </AccountFrame>
  );
}
