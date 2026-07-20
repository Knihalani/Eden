"use client";

import Link from "next/link";
import { ShieldOff } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/use-permissions";
import {
  IMPROVE_FEATURE_DISABLED_DESCRIPTION,
  IMPROVE_FEATURE_DISABLED_TITLE,
} from "@/lib/improve-feature";
import { DOCS_QUICKSTART_URL, SUPPORT_EMAIL } from "@/lib/constants";

/** Honest empty state when improvement_agent_v1 returns 503 / disabled. */
export function ImproveFeatureDisabledState({
  className,
}: {
  className?: string;
}) {
  const { hasPermission } = usePermissions();
  const canEditSettings = hasPermission("settings:edit");

  return (
    <EmptyState
      className={className}
      variant="plain"
      icon={ShieldOff}
      title={IMPROVE_FEATURE_DISABLED_TITLE}
      description={
        canEditSettings
          ? IMPROVE_FEATURE_DISABLED_DESCRIPTION
          : "The improvement agent is not enabled for this organization. Ask an organization owner or admin to contact Eden support — Settings cannot turn this on for you."
      }
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {canEditSettings ? (
            <Button asChild className="min-h-11">
              <a href={`mailto:${SUPPORT_EMAIL}?subject=Enable%20improvement_agent_v1`}>
                Contact support
              </a>
            </Button>
          ) : (
            <Button asChild className="min-h-11">
              <Link href="/traces">Open Traces</Link>
            </Button>
          )}
          <Button asChild variant="outline" className="min-h-11">
            <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
              Docs
            </a>
          </Button>
          <Button asChild variant="ghost" className="min-h-11">
            <Link href="/improve">Back to Improve</Link>
          </Button>
        </div>
      }
    />
  );
}
