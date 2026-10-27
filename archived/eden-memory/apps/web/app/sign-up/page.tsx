import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AccountFrame } from "../account/frame";
import { SEE_PENDING, signedInDest } from "../account/home";
import { SignUpForm } from "./form";

export const metadata = {
  title: "Sign up — Eden",
};

export default async function SignUpPage() {
  const dest = signedInDest(await auth(SEE_PENDING));
  if (dest) redirect(dest);

  return (
    <AccountFrame other="signin">
      <SignUpForm />
    </AccountFrame>
  );
}
