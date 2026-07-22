import { redirect } from "next/navigation";

/** Redirect-only — session detail lives inside the Traces hub (IA §7.1). */
export default async function SessionDetailRedirectPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  redirect(`/traces?view=sessions&sessionId=${encodeURIComponent(sessionId)}`);
}
