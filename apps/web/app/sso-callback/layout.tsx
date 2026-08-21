import type { ReactNode } from "react";
import { ClerkShell } from "../clerk-shell";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <ClerkShell>{children}</ClerkShell>;
}
