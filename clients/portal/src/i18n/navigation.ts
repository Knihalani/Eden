import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/**
 * Locale-aware wrappers around next/navigation. Prefer these over
 * the raw `next/link` + `next/navigation` imports inside components
 * so navigation respects the active locale prefix.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);