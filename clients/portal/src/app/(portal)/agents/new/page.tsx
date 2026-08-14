import { SetupClient } from "./setup-client";

export const metadata = {
  title: "New agent · Eden",
  description: "Name the job, pick watch and notify Slack channels.",
};

export default function NewAgentPage() {
  return <SetupClient />;
}
