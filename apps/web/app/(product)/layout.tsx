import type { ReactNode } from "react";
import { ClerkShell } from "../clerk-shell";
import { AppChrome } from "../home/chrome";
import { EMPTY_ACTIVITY } from "../home/activity";
import { EMPTY_PORTRAIT } from "../home/portrait";

export const dynamic = "force-dynamic";
export const fetchCache = "default-no-store";

export default function ProductLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkShell>
      <link rel="preconnect" href="https://img.clerk.com" />
      <AppChrome initial={EMPTY_ACTIVITY} portrait={EMPTY_PORTRAIT}>
        {children}
      </AppChrome>
    </ClerkShell>
  );
}
