import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SEE_PENDING } from "../../account/home";
import { productGate } from "../../account/route";
import { WorkspaceForm } from "../../workspace/form";

export const metadata = {
  title: "Workspace — Eden",
};

export default async function WorkspacePage() {
  const dest = productGate("/workspace", await auth(SEE_PENDING));
  if (dest) redirect(dest);
  return <WorkspaceForm />;
}
