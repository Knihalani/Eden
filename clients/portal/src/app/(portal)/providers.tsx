"use client";

/**
 * Portal-only provider tree.
 *
 * A3 created this module; P2-phase2 mounts it from `(portal)/layout.tsx`
 * so marketing/auth skip Auth/Org/Query/Toast/Notifications/Motion.
 */

import { Suspense, type ReactNode } from "react";
import { AuthProvider } from "@/hooks/use-auth";
import { OrgProvider } from "@/hooks/use-org";
import { ToastProvider } from "@/components/ui/toast";
import { NotificationsProvider } from "@/hooks/use-notifications";
import { QueryProvider } from "@/components/providers/query-provider";
import { MotionProvider } from "@/components/providers/motion-provider";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { AiSessionProvider } from "@/components/ai-agent/ai-session-provider";

export function PortalProviders({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <AuthProvider>
        <OrgProvider>
          <ToastProvider>
            <MotionProvider>
              <TooltipProvider delayDuration={200} skipDelayDuration={300}>
                <NotificationsProvider>
                  <Suspense>
                    <AiSessionProvider>{children}</AiSessionProvider>
                  </Suspense>
                </NotificationsProvider>
              </TooltipProvider>
            </MotionProvider>
          </ToastProvider>
        </OrgProvider>
      </AuthProvider>
    </QueryProvider>
  );
}
