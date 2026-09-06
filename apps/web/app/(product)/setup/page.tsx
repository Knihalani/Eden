import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SEE_PENDING } from "../../account/home";
import { productGate } from "../../account/route";
import { SetupPrompt } from "../../home/prompt";
import { PLACEHOLDER_ENV } from "../../home/prompt-text";

export const metadata = {
  title: "Setup — Eden",
};

export default async function SetupPage() {
  const session = await auth(SEE_PENDING);
  const dest = productGate("/setup", session);
  if (dest) redirect(dest);

  return (
    <Suspense fallback={<SetupFallback />}>
      <SetupPrompt placeholders={PLACEHOLDER_ENV} />
    </Suspense>
  );
}

function SetupFallback() {
  return (
    <section className="account-stage account-stage-prompt" aria-busy="true">
      <div className="account-copy account-copy-wide">
        <h1>Copy this into your agent</h1>
      </div>
    </section>
  );
}
