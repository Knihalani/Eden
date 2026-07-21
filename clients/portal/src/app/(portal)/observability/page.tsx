import { redirect } from "next/navigation";

/**
 * Wave 3 IA — `/observability` landing retired.
 * Facet/view deep links stay on child routes and soft-nest under `/traces`
 * via next.config + HUB_REDIRECT_RULES.
 */
export default function ObservabilityLandingRetired() {
  redirect("/traces");
}
