import { redirect } from "next/navigation";

/**
 * Legacy /alerts URL → Detectors (/signals).
 *
 * Product leaf for threshold / signal rules is /signals (nav: Detectors).
 * The firing inbox remains the shell alerts modal (bell). Soft-landing
 * here instead of /home so bookmarks and stale nav links stay useful.
 */
export default function AlertsSoftLandPage() {
  redirect("/signals");
}
