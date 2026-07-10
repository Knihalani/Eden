import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** True when href leaves the portal (http/https). */
export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}