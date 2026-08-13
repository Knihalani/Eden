import { Metadata } from "next";
import DashboardsClient from "./dashboards-client";

export const metadata: Metadata = {
  title: "Dashboards · Eden",
  description: "Custom monitoring dashboards for your LLM agents.",
};

export default function DashboardsPage() {
  return <DashboardsClient />;
}
