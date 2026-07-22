import { redirect } from "next/navigation";

/** Redirect-only — session detail lives inside the Traces hub (IA §7.1). */
export default function SessionDetailRedirectPage({
  params,
}: {
  params: { sessionId: string };
}) {
  const { sessionId } = params;
  redirect(`/traces?view=sessions&sessionId=${encodeURIComponent(sessionId)}`);
}
