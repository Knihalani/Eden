/**
 * /onboarding/tour — Step 4: Visual tour of the portal.
 *
 * The wizard body is the <TourStep> component; this thin page
 * exists so the wizard's slug-based routing has a real route to
 * land on. (The wizard matches the slug to the right step in STEPS
 * and renders the corresponding render() — without a matching
 * page, /onboarding/tour would 404 even though the wizard chrome
 * would happily navigate to it.)
 *
 * We render null here and let the wizard own the body via the
 * ``render: () => <TourStep />`` entry in layout.tsx — the wizard
 * prefers ``render()`` over children when both are present.
 */
export default function OnboardingTourPage() {
  return null;
}
