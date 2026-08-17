import { LiveView } from "../view";

const KEY = process.env.EDEN_API_KEY || "eden_dev";

export default async function LiveToolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LiveView token={KEY} initialId={id} />;
}
