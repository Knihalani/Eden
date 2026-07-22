"use client";

import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { ImproveQueueStatus } from "@/lib/improve-url";

export type ImproveHubToolbarProps = {
  q: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  queueStatus?: ImproveQueueStatus;
  onQueueStatusChange?: (status: ImproveQueueStatus | undefined) => void;
  showQueueViews?: boolean;
  primaryAction?: ReactNode;
  queueLabels?: {
    needsYou: string;
    inProgress: string;
    verify: string;
  };
};

const QUEUE_VIEWS: ImproveQueueStatus[] = [
  "needs_you",
  "in_progress",
  "verify",
];

export function ImproveHubToolbar({
  q,
  onSearchChange,
  searchPlaceholder,
  queueStatus,
  onQueueStatusChange,
  showQueueViews,
  primaryAction,
  queueLabels,
}: ImproveHubToolbarProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="improve-hub-toolbar"
    >
      {showQueueViews && onQueueStatusChange && queueLabels ? (
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="Queue views"
          data-testid="improve-queue-views"
        >
          {QUEUE_VIEWS.map((id) => {
            const label =
              id === "needs_you"
                ? queueLabels.needsYou
                : id === "in_progress"
                  ? queueLabels.inProgress
                  : queueLabels.verify;
            const active = (queueStatus ?? "needs_you") === id;
            return (
              <Button
                key={id}
                type="button"
                size="sm"
                variant={active ? "secondary" : "ghost"}
                className="min-h-11"
                onClick={() => onQueueStatusChange(id)}
                data-testid={`improve-queue-view-${id}`}
              >
                {label}
              </Button>
            );
          })}
        </div>
      ) : null}
      <Input
        value={q}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={searchPlaceholder}
        className="max-w-xs"
        aria-label={searchPlaceholder}
        data-testid="improve-search"
      />
      {primaryAction}
    </div>
  );
}
