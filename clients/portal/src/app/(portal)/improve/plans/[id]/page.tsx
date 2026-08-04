import { redirect } from "next/navigation";

export const metadata = { title: "Improve · Eden" };

/**
 * `/improve/plans/<id>` → `/improve?mode=plan&id=<id>`.
 *
 * Plan detail is a mode within Improve, not a separate page —
 * the improve client reads the plan from `?mode=plan&id=`. Citations and
 * older links still produce `/improve/plans/:id`; without this redirect
 * those URLs 404 via the global catch-all.
 */
export default async function ImprovePlanRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/improve?mode=plan&id=${encodeURIComponent(id)}`);
}
