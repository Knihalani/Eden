"use client";

import Link from "next/link";
import { useState } from "react";
import {
  RETENTION_OPTIONS,
  TIMEZONE_OPTIONS,
  activeKeys,
  auditSnapshot,
  densityLabel,
  memberCounts,
  type ApiKeyFixture,
  type AuditEventFixture,
  type AuditPackFixture,
  type MemberFixture,
  type RetentionDays,
  type WorkspaceFixture,
} from "@/lab/fixtures/settings";
import { HealthChip } from "@/lab/settings/settings-chrome";
import type { SettingsMode } from "@/lab/settings/settings-chrome";
import { AutonomySettingsCard } from "@/lab/settings/autonomy-settings-card";
import { AutonomyAuditCard } from "@/lab/settings/autonomy-audit-card";
import { SlackSettingsCard } from "@/lab/settings/slack-settings-card";
import { AccountDangerZoneCard } from "@/lab/settings/account-danger-zone-card";
import { useLabToast } from "@/lab/lab-toast";
import { formatSmartTime } from "@/lib/format";

export function SettingsWorkspaceView({
  workspace,
  keys,
  members,
  packs,
  events,
  canEdit = true,
  onGo,
  onRename,
  onPatch,
}: {
  workspace: WorkspaceFixture;
  keys: ApiKeyFixture[];
  members: MemberFixture[];
  packs: AuditPackFixture[];
  events: AuditEventFixture[];
  /** False for member/viewer roles — hides rename and pref controls. */
  canEdit?: boolean;
  onGo: (mode: SettingsMode, opts?: { tab?: "events" | "packs" }) => void;
  onRename: (name: string) => void | Promise<void>;
  onPatch: (
    patch: Partial<WorkspaceFixture>,
    label: string,
  ) => void | Promise<void>;
}) {
  const { pushToast } = useLabToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(workspace.name);

  const snap = auditSnapshot({ keys, members, packs, events });
  const liveKeys = activeKeys(keys);
  const counts = memberCounts(members);
  const packOk = snap.packs.broken === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section className="border-b border-[var(--line)] px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="type-label">Overview</p>
            {editing ? (
              <form
                className="mt-2 flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = draft.trim();
                  if (!next || next === workspace.name) {
                    setEditing(false);
                    setDraft(workspace.name);
                    return;
                  }
                  setSaving(true);
                  void (async () => {
                    try {
                      await onRename(next);
                      setEditing(false);
                      pushToast({
                        title: "Workspace renamed",
                        body: next,
                        tone: "ok",
                      });
                    } catch {
                      /* parent toasts failure */
                    } finally {
                      setSaving(false);
                    }
                  })();
                }}
              >
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="ds-input max-w-sm flex-1"
                  aria-label="Workspace name"
                  autoFocus
                />
                <button
                  type="submit"
                  className="ds-btn ds-btn-primary ds-btn-sm"
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  onClick={() => {
                    setEditing(false);
                    setDraft(workspace.name);
                  }}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <h2 className="type-display !text-[1.5rem] text-[var(--text)]">
                  {workspace.name}
                </h2>
                {canEdit ? (
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm"
                    onClick={() => {
                      setDraft(workspace.name);
                      setEditing(true);
                    }}
                  >
                    Rename
                  </button>
                ) : null}
              </div>
            )}
            <p className="type-meta mt-2">
              {workspace.slug}
              <span className="mx-1.5 text-[var(--text-faint)]">·</span>
              {workspace.planLabel} plan
              <span className="mx-1.5 text-[var(--text-faint)]">·</span>
              since {formatSmartTime(workspace.createdAt)}
            </p>
          </div>
          <Link href="/cost" className="ds-btn ds-btn-ghost ds-btn-sm">
            Plan & budget
          </Link>
        </div>
      </section>

      <div className="grid shrink-0 gap-3 border-b border-[var(--line)] px-4 py-4 sm:grid-cols-3 sm:gap-4 sm:px-6">
        <HealthCard
          label="API keys"
          value={String(liveKeys.length)}
          hint={
            liveKeys.length
              ? `${liveKeys.length} active · click to manage`
              : "None — ingest blocked"
          }
          ok={liveKeys.length > 0}
          okLabel="Ready"
          failLabel="Missing"
          onClick={() => onGo("keys")}
        />
        <HealthCard
          label="Members"
          value={String(counts.active)}
          hint={
            counts.invited
              ? `${counts.invited} invited · ${counts.total} total`
              : `${counts.total} on the workspace`
          }
          ok={counts.active > 0}
          okLabel="Staffed"
          failLabel="Empty"
          onClick={() => onGo("members")}
        />
        <HealthCard
          label="Audit"
          value={packOk ? "Clean" : `${snap.packs.broken} broken`}
          hint={
            snap.latestEvent
              ? `${snap.latestEvent.action} · ${snap.latestEvent.at}`
              : "No events yet"
          }
          ok={packOk}
          okLabel="Verified"
          failLabel="Review"
          onClick={() =>
            onGo("audit", { tab: packOk ? "events" : "packs" })
          }
        />
      </div>

      <AutonomySettingsCard canEdit={canEdit} />
      <AutonomyAuditCard />

      <SlackSettingsCard />

      <section className="border-b border-[var(--line)] px-4 py-5 sm:px-6">
        <p className="type-label mb-4">Workspace prefs</p>        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <PrefSelect
            label="Timezone"
            value={workspace.timezone}
            disabled={!canEdit}
            options={TIMEZONE_OPTIONS.map((t) => ({ value: t, label: t }))}
            onChange={(timezone) => {
              void (async () => {
                try {
                  await onPatch({ timezone }, `timezone → ${timezone}`);
                  pushToast({
                    title: "Timezone updated",
                    body: timezone,
                    tone: "ok",
                  });
                } catch {
                  /* parent toasts failure */
                }
              })();
            }}
          />
          <PrefSelect
            label="Retention"
            value={String(workspace.retentionDays)}
            disabled={!canEdit}
            options={RETENTION_OPTIONS.map((d) => ({
              value: String(d),
              label: `${d} days`,
            }))}
            onChange={(v) => {
              const retentionDays = Number(v) as RetentionDays;
              void (async () => {
                try {
                  await onPatch(
                    { retentionDays },
                    `retention → ${retentionDays}d`,
                  );
                  pushToast({
                    title: "Retention updated",
                    body: `${retentionDays} days`,
                    tone: "ok",
                  });
                } catch {
                  /* parent toasts failure */
                }
              })();
            }}
          />
          <div>
            <p className="type-label">Density</p>
            <div className="mt-1.5 flex gap-1" role="group" aria-label="UI density">
              {(["comfortable", "compact"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className="ds-tab"
                  disabled={!canEdit}
                  aria-pressed={workspace.density === d}
                  onClick={() => {
                    if (d === workspace.density) return;
                    void (async () => {
                      try {
                        await onPatch({ density: d }, `density → ${d}`);
                        pushToast({
                          title: "Density updated",
                          body: densityLabel(d),
                          tone: "ok",
                        });
                      } catch {
                        /* parent toasts failure */
                      }
                    })();
                  }}
                >
                  {densityLabel(d)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="type-label">PII redaction</p>
            <button
              type="button"
              className="ds-tab mt-1.5"
              disabled={!canEdit}
              aria-pressed={workspace.piiRedaction}
              onClick={() => {
                const piiRedaction = !workspace.piiRedaction;
                void (async () => {
                  try {
                    await onPatch(
                      { piiRedaction },
                      `pii → ${piiRedaction ? "on" : "off"}`,
                    );
                    pushToast({
                      title: piiRedaction
                        ? "PII redaction on"
                        : "PII redaction off",
                      tone: piiRedaction ? "ok" : "fail",
                    });
                  } catch {
                    /* parent toasts failure */
                  }
                })();
              }}
            >
              {workspace.piiRedaction ? "On" : "Off"}
            </button>
            <p className="type-meta mt-1.5">
              Strip emails, cards, and secrets in traces.
            </p>
          </div>
        </div>
      </section>

      <AccountDangerZoneCard />
    </div>
  );
}

function PrefSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const safeOptions =
    value && !options.some((o) => o.value === value)
      ? [{ value, label: value }, ...options]
      : options;

  return (
    <label className="block">
      <span className="type-label">{label}</span>
      <select
        className="ds-input mt-1.5 w-full"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      >
        {safeOptions.map((o) => (
          <option key={o.value || "__unset"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function HealthCard({
  label,
  value,
  hint,
  ok,
  okLabel,
  failLabel,
  onClick,
}: {
  label: string;
  value: string;
  hint: string;
  ok: boolean;
  okLabel: string;
  failLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${value}, ${ok ? okLabel : failLabel}. ${hint}`}
      className="block rounded-[var(--radius)] px-3.5 py-3 text-left shadow-[0_0_0_1px_var(--line)] transition-colors duration-150 ease-out hover:bg-[var(--bg-hover)] sm:px-4"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="type-label">{label}</p>
        <HealthChip ok={ok} okLabel={okLabel} failLabel={failLabel} />
      </div>
      <p className="type-ui mt-1.5 text-[var(--text)]">{value}</p>
      <p className="type-meta mt-1">{hint}</p>
    </button>
  );
}
