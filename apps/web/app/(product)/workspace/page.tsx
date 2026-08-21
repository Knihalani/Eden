import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SEE_PENDING } from "../../account/home";
import { WorkspaceForm } from "../../workspace/form";

export const metadata = {
  title: "Workspace — Eden",
};

export default async function WorkspacePage() {
  const { userId } = await auth(SEE_PENDING);
  if (!userId) redirect("/sign-in");

  return <WorkspaceForm />;
}
