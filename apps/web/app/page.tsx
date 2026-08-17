import { Dashboard } from "./dashboard";

const WRAP = process.env.EDEN_WRAP_URL || "http://127.0.0.1:8788";
const KEY = process.env.EDEN_API_KEY || "eden_dev";

export default function HomePage() {
  return <Dashboard wrap={WRAP} token={KEY} />;
}
