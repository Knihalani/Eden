import { Dashboard } from "@/app/dashboard";

const WRAP = process.env.EDEN_WRAP_URL || "http://127.0.0.1:8788";
const KEY = process.env.EDEN_API_KEY || "eden_dev";

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Dashboard wrap={WRAP} token={KEY} initialId={id} />;
}
