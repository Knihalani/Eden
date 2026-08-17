import { LiveView } from "./view";

const KEY = process.env.EDEN_API_KEY || "eden_dev";

export default function LivePage() {
  return <LiveView token={KEY} />;
}
