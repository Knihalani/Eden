import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SEE_PENDING, WORKSPACE } from "../../account/home";
import { SetupPrompt } from "../../home/prompt";
import { PLACEHOLDER_ENV } from "../../home/prompt-text";

export const metadata = {
  title: "Setup — Eden",
};

export default async function SetupPage() {
  const { userId, orgId, sessionStatus } = await auth(SEE_PENDING);
  if (!userId) redirect("/");
  if (sessionStatus === "pending" || !orgId) redirect(WORKSPACE);

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
