import { redirect } from "next/navigation";

/** Legacy /billing — billing lives in Settings → Billing tab. */
export default function BillingPage() {
  redirect("/settings?tab=billing");
}
