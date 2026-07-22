import { redirect } from "next/navigation";

/** Thin redirect — artifacts live under Improve. */
export default async function AgentArtifactsRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(
    `/improve?tab=artifacts&agentId=${encodeURIComponent(id)}`,
  );
}
