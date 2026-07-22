import { redirect } from "next/navigation";

/** Redirect-only — Sessions is a Traces hub lens (IA §7.1). */
export default function SessionsRedirectPage() {
  redirect("/traces?view=sessions");
}
