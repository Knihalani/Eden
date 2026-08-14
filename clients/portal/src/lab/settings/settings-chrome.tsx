"use client";

import Link from "next/link";
import { StatusChip } from "@/components/ds/primitives";
import {
  keyStatusLabel,
  memberStatusLabel,
  packKindLabel,
  roleLabel,
  type AuditPackKind,
  type KeyStatus,
  type MemberRole,
  type MemberStatus,
} from "@/lab/fixtures/settings";

export type SettingsMode =
  | "workspace"
  | "keys"
  | "members"
  | "audit"
  | "roles"
  | "sso"
  | "pii"
  | "scim";
export type AuditTab = "events" | "packs";

/** Map legacy ``?tab=`` bookmarks / command palette hrefs to modes. */
const LEGACY_TAB_TO_MODE: Record<string, SettingsMode> = {
  "api-keys": "keys",
  keys: "keys",
  org: "workspace",
  account: "workspace",
  members: "members",
  references: "workspace",
  mcp: "workspace",
  security: "workspace",
  // These now have dedicated ``/settings/{mode}`` screens rather than
  // aliasing into the workspace overview — ``page.tsx`` redirects any
  // ``?mode=`` value below to its real route.
  scim: "scim",
  gateway: "workspace",
  pii: "pii",
  roles: "roles",
  sso: "sso",
  retention: "workspace",
  exports: "workspace",
  status: "workspace",
  analytics: "workspace",
  billing: "workspace",
  finops: "workspace",
  autonomous: "workspace",
  sidebar: "workspace",
  "audit-log": "audit",
  audit: "audit",
};

/**
 * Resolve settings mode from ``?mode=`` or legacy ``?tab=``.
 * Prefer ``mode`` when both are present.
 */
export function resolveSettingsModeParam(
  mode: string | null,
  tab: string | null = null,
): string | null {
  if (mode) return mode;
  if (!tab) return null;
  return LEGACY_TAB_TO_MODE[tab] ?? null;
}

export function parseSettingsMode(mode: string | null): SettingsMode {
  if (mode === "api-keys") return "keys";
  if (
    mode === "keys" ||
    mode === "members" ||
    mode === "audit" ||
    mode === "roles" ||
    mode === "sso" ||
    mode === "pii" ||
    mode === "scim"
  ) {
    return mode;
  }
  return "workspace";
}

/** Modes that resolve to a dedicated ``/settings/{mode}`` route rather
 *  than an in-page tab rendered by ``/settings/page.tsx``. */
export const SETTINGS_ROUTE_MODES: readonly SettingsMode[] = [
  "roles",
  "sso",
  "pii",
  "scim",
];

export function parseAuditTab(tab: string | null): AuditTab {
  if (tab === "packs") return "packs";
  return "events";
}

export function settingsModeHref(id: SettingsMode): string {
  if (id === "workspace") return "/settings";
  if (
    id === "roles" ||
    id === "sso" ||
    id === "pii" ||
    id === "scim"
  ) {
    return `/settings/${id}`;
  }
  return `/settings?mode=${id}`;
}

const SETTINGS_TABS: ReadonlyArray<{
  id: SettingsMode;
  label: string;
}> = [
  { id: "workspace", label: "Overview" },
  { id: "keys", label: "API keys" },
  { id: "members", label: "Members" },
  { id: "roles", label: "Roles" },
  { id: "sso", label: "SSO" },
  { id: "pii", label: "PII policy" },
  { id: "scim", label: "SCIM" },
  { id: "audit", label: "Audit" },
];

export function SettingsModeNav({
  value,
  onChange,
}: {
  value: SettingsMode;
  onChange?: (next: SettingsMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Settings mode"
      className="flex min-w-0 max-w-full flex-wrap gap-1 overflow-x-auto"
    >
      {SETTINGS_TABS.map(({ id, label }) => {
        const selected = value === id;
        return (
          <Link
            key={id}
            href={settingsModeHref(id)}
            role="tab"
            aria-selected={selected}
            data-active={selected ? "true" : undefined}
            className="ds-tab"
            data-tour-id={id === "keys" ? "api-keys" : undefined}
            onClick={() => onChange?.(id)}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}

export function AuditTabNav({
  value,
  onChange,
}: {
  value: AuditTab;
  onChange: (next: AuditTab) => void;
}) {
  return (
    <div role="tablist" aria-label="Audit view" className="flex gap-1">
      {(
        [
          ["events", "Events"],
          ["packs", "Packs"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          className="ds-tab"
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function KeyStatusChip({ status }: { status: KeyStatus }) {
  return (
    <StatusChip tone={status === "active" ? "ok" : "fail"}>
      {keyStatusLabel(status)}
    </StatusChip>
  );
}

export function MemberRoleChip({ role }: { role: MemberRole }) {
  return <StatusChip tone="neutral">{roleLabel(role)}</StatusChip>;
}

export function MemberStatusChip({ status }: { status: MemberStatus }) {
  const tone = status === "disabled" ? "fail" : "neutral";
  return (
    <StatusChip tone={tone}>{memberStatusLabel(status)}</StatusChip>
  );
}

export function PackKindChip({ kind }: { kind: AuditPackKind }) {
  return <StatusChip tone="neutral">{packKindLabel(kind)}</StatusChip>;
}

export function VerifyChip({ verified }: { verified: boolean }) {
  return (
    <StatusChip tone={verified ? "ok" : "fail"}>
      {verified ? "Verified" : "Broken"}
    </StatusChip>
  );
}

export function HealthChip({
  ok,
  okLabel,
  failLabel,
}: {
  ok: boolean;
  okLabel: string;
  failLabel: string;
}) {
  return (
    <StatusChip tone={ok ? "ok" : "fail"}>
      {ok ? okLabel : failLabel}
    </StatusChip>
  );
}
