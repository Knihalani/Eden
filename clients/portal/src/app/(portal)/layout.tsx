/**
 * Portal route-group layout (RSC shell).
 *
 * P2-phase2: providers + chrome live here so marketing/auth do not
 * mount Auth/Org/Query/Toast/Notifications/Motion. Client interactivity
 * stays in ``portal-chrome.tsx`` (and A3 ``providers.tsx``).
 */

import { PortalProviders } from "./providers";
import { PortalChrome } from "./portal-chrome";

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PortalProviders>
      <PortalChrome>{children}</PortalChrome>
    </PortalProviders>
  );
}
