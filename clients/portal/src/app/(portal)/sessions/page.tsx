import { redirect } from "next/navigation";

export const metadata = { title: "Sessions · Eden" };

/** Sessions are a Traces lens — not a separate Observe product leaf. */
export default function LabSessionsPage() {
  redirect("/traces?view=sessions");
}
