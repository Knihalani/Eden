/**
 * Marketing CTA constants (re-exported for callers that historically
 * imported from this module). Session detection for marketing CTAs is
 * client-side — see ``marketing-signed-in-client.ts`` — so public pages
 * do not call Clerk ``auth()`` and stay out of the dynamic SSR path.
 */

export {
  MARKETING_APP_HREF,
  MARKETING_APP_LABEL,
} from "@/lib/marketing-cta";
