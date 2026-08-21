import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SEE_PENDING, WORKSPACE } from "../../account/home";
import { TourPanel } from "../../home/tour";

export const metadata = {
  title: "Tour — Eden",
};

export default async function TourPage() {
  const { userId, orgId, sessionStatus } = await auth(SEE_PENDING);
  if (!userId) redirect("/");
  if (sessionStatus === "pending" || !orgId) redirect(WORKSPACE);
  return <TourPanel />;
}
