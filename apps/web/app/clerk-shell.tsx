"use client";

import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";

export function ClerkShell({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/"
      signInFallbackRedirectUrl="/workspace"
      signUpFallbackRedirectUrl="/workspace"
      taskUrls={{ "choose-organization": "/workspace" }}
      telemetry={false}
      appearance={{
        variables: {
          colorPrimary: "oklch(0.64 0.21 18)",
          colorBackground: "oklch(0.16 0.012 260)",
          colorForeground: "oklch(0.93 0.012 260)",
          colorInput: "oklch(0.2 0.012 260)",
          colorInputForeground: "oklch(0.93 0.012 260)",
          colorMutedForeground: "oklch(0.78 0.014 260)",
          colorDanger: "oklch(0.74 0.07 15)",
          borderRadius: "2px",
          fontFamily: "var(--font-ui)",
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
