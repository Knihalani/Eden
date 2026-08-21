import { Suspense } from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SEE_PENDING, WORKSPACE } from "../../account/home";
import { DashBoard } from "../../home/board";

export const metadata = {
  title: "Home — Eden",
};

export default async function HomePage() {
  const { userId, orgId, sessionStatus } = await auth(SEE_PENDING);
  if (!userId) redirect("/");
  if (sessionStatus === "pending" || !orgId) redirect(WORKSPACE);

  return (
    <Suspense fallback={<div className="home" aria-busy="true" />}>
      <DashBoard />
    </Suspense>
  );
}
