"use client";

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

export type SettingsMode = "workspace" | "keys" | "members" | "audit";
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
  scim: "workspace",
  gateway: "workspace",
  pii: "workspace",
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
  if (mode === "keys" || mode === "members" || mode === "audit") return mode;
  return "workspace";
}

export function parseAuditTab(tab: string | null): AuditTab {
  if (tab === "packs") return "packs";
  return "events";
}

export function SettingsModeNav({
  value,
  onChange,
}: {
  value: SettingsMode;
  onChange: (next: SettingsMode) => void;
}) {
  return (
    <div role="tablist" aria-label="Settings mode" className="flex gap-1">
      {(
        [
          ["workspace", "Overview"],
          ["keys", "API keys"],
          ["members", "Members"],
          ["audit", "Audit"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          className="ds-tab"
          data-tour-id={id === "keys" ? "api-keys" : undefined}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
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
