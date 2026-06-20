"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface TagProps extends React.HTMLAttributes<HTMLDivElement> {}

function Tag({ className, ...props }: TagProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        "bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
        className
      )}
      {...props}
    />
  );
}
Tag.displayName = "Tag";

export { Tag };
