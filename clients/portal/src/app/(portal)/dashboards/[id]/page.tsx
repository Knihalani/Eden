import { Metadata } from "next";
import DashboardDetailClient from "./dashboard-detail-client";

export const metadata: Metadata = {
  title: "Dashboard · Eden",
};

export default async function DashboardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DashboardDetailClient dashboardId={id} />;
}
