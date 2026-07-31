"use client";

import type { ReactNode } from "react";

/**
 * Honesty banner for local-only / not-yet-persisted UI state.
 * Use whenever the page mutates React state that looks like a save
 * but never hits the API — never pair with a success toast.
 */
export function LocalDraftBanner({
  children = "Changes on this page are local drafts and are not saved to the server yet.",
}: {
  children?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="mx-5 mt-3 rounded-[var(--radius)] border border-[var(--warning)]/40 bg-[var(--warning-muted)] px-3 py-2 type-meta text-[var(--text)]"
    >
      {children}
    </div>
  );
}
