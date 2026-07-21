"use client";

/**
 * Wave 6 — Settings compliance body retired.
 * Canonical reader: `/audit-trail` (Events | Chain packs).
 * Hub redirects `?tab=audit-log` before this mounts; stub is defensive only.
 */
import Link from "next/link";
import { FileText } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { SETTINGS_AUDIT_LOG_REDIRECT_HREF } from "./settings-tab-registry";

const EVENTS_HREF = `${SETTINGS_AUDIT_LOG_REDIRECT_HREF}?segment=events`;

export function AuditLogTab(_props: { org?: unknown }) {
  return (
    <div data-ws6-audit-stub="true" className="py-space-6">
      <EmptyState
        variant="plain"
        icon={FileText}
        title="Audit log moved"
        description="Privileged workspace events and chain packs live on Audit trail. This Settings tab redirects there automatically."
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={EVENTS_HREF}>Open audit trail</Link>
          </Button>
        }
      />
    </div>
  );
}
