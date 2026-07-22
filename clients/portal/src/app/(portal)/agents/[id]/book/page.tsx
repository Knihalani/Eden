import { redirect } from "next/navigation";

export default async function AgentBookRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/agents/${encodeURIComponent(id)}?tab=book`);
}
