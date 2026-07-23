"use client";

import Image from "next/image";
import { cn } from "@/lib/utils";

type EdenLogoProps = {
  size?: number;
  className?: string;
  priority?: boolean;
};

/** Real Eden mark from /public/logo.webp — use instead of gradient placeholders. */
export function EdenLogo({ size = 24, className, priority }: EdenLogoProps) {
  return (
    <Image
      src="/logo.webp"
      alt="Eden"
      width={size}
      height={size}
      priority={priority}
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
