import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SEE_PENDING, WORKSPACE, homePath } from "../../../account/home";
import { CanvasMiss } from "../../../canvas/miss";
import { CanvasView } from "../../../canvas/view";
import { loadCanvas } from "../../../canvas/load";

export const metadata = {
  title: "Request — Eden",
};

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId, orgId, sessionStatus } = await auth(SEE_PENDING);
  if (!userId) redirect("/");
  if (sessionStatus === "pending" || !orgId) redirect(WORKSPACE);
  const { id } = await params;
  const loaded = await loadCanvas("request", id);
  if (loaded.status === "error") return <CanvasMiss list="requests" href={homePath("requests")} error />;
  if (loaded.status === "miss") return <CanvasMiss list="requests" href={homePath("requests")} />;
  return <CanvasView model={loaded.model} />;
}
