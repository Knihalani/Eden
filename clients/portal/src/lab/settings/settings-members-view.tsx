"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  roleLabel,
  type MemberFixture,
  type MemberRole,
} from "@/lab/fixtures/settings";
import { EmptyState, FilterChips } from "@/lab/lab-ui";
import { useLabToast } from "@/lab/lab-toast";
import {
  MemberRoleChip,
  MemberStatusChip,
} from "@/lab/settings/settings-chrome";
import { cn } from "@/lib/utils";

type MemberFilter = "all" | "active" | "invited" | "disabled";

export function SettingsMembersView({
  members,
  selectedId,
  onSelect,
  onClose,
  onInvite,
  onRole,
  onResend,
  onDisable,
  onEnable,
}: {
  members: MemberFixture[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onInvite: (email: string, role: MemberRole) => Promise<MemberFixture>;
  onRole: (id: string, role: MemberRole) => void;
  onResend: (id: string) => void;
  onDisable: (id: string) => void;
  onEnable: (id: string) => void;
}) {
  const { pushToast } = useLabToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [filter, setFilter] = useState<MemberFilter>("all");

  const filtered = useMemo(() => {
    if (filter === "all") return members;
    return members.filter((m) => m.status === filter);
  }, [members, filter]);

  const selected = selectedId
    ? (members.find((m) => m.id === selectedId) ?? null)
    : null;

  const counts = {
    all: members.length,
    active: members.filter((m) => m.status === "active").length,
    invited: members.filter((m) => m.status === "invited").length,
    disabled: members.filter((m) => m.status === "disabled").length,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 border-b border-[var(--line)] px-4 py-3 sm:px-6">
        <FilterChips
          value={filter}
          onChange={setFilter}
          options={[
            { id: "all", label: "All", count: counts.all },
            { id: "active", label: "Active", count: counts.active },
            { id: "invited", label: "Invited", count: counts.invited },
            { id: "disabled", label: "Disabled", count: counts.disabled },
          ]}
        />
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[12rem] flex-1">
            <span className="type-label">Invite</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className="ds-input mt-1.5 w-full"
              aria-label="Invite email"
            />
          </label>
          <label>
            <span className="type-label">Role</span>
            <select
              className="ds-input mt-1.5 !h-9 !w-auto !py-0"
              value={role}
              onChange={(e) => setRole(e.target.value as MemberRole)}
              aria-label="Invite role"
            >
              <option value="admin">Admin</option>
              <option value="member">Member</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={!email.trim().includes("@")}
            onClick={async () => {
              try {
                const invited = await onInvite(email.trim(), role);
                setEmail("");
                setFilter("all");
                onSelect(invited.id);
                pushToast({
                  title: "Invite sent",
                  body: `${invited.email} · ${roleLabel(invited.role)}`,
                  tone: "ok",
                });
              } catch (err) {
                pushToast({
                  title: "Invite failed",
                  body: err instanceof Error ? err.message : "Try again.",
                  tone: "fail",
                });
              }
            }}
          >
            Invite
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          compact
          title={members.length === 0 ? "No members" : "No matches"}
          body={
            members.length === 0
              ? "Invite someone to share this workspace."
              : "Try another filter."
          }
          action={
            filter !== "all" ? (
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={() => setFilter("all")}
              >
                Clear filter
              </button>
            ) : undefined
          }
        />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {filtered.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onSelect(m.id)}
                className={cn(
                  "flex w-full flex-wrap items-center gap-3 border-b border-[var(--line)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)] sm:px-6",
                  selectedId === m.id && "bg-[var(--accent-muted)]",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <MemberStatusChip status={m.status} />
                    <MemberRoleChip role={m.role} />
                    <span className="type-ui truncate text-[var(--text)]">
                      {m.name}
                    </span>
                  </div>
                  <p className="type-meta">
                    {m.email}
                    <span className="mx-1.5 text-[var(--text-faint)]">·</span>
                    {m.lastActive}
                  </p>
                </div>
                <span className="type-meta shrink-0 text-[var(--accent)]">
                  Edit
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <MemberDialog
          member={selected}
          onClose={onClose}
          onRole={onRole}
          onResend={onResend}
          onDisable={onDisable}
          onEnable={onEnable}
        />
      ) : null}
    </div>
  );
}

function MemberDialog({
  member,
  onClose,
  onRole,
  onResend,
  onDisable,
  onEnable,
}: {
  member: MemberFixture;
  onClose: () => void;
  onRole: (id: string, role: MemberRole) => void;
  onResend: (id: string) => void;
  onDisable: (id: string) => void;
  onEnable: (id: string) => void;
}) {
  const { pushToast } = useLabToast();
  const canChangeRole =
    member.role !== "owner" && member.status === "active";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-[var(--scrim)] p-3 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="member-dialog-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <MemberStatusChip status={member.status} />
              <MemberRoleChip role={member.role} />
            </div>
            <h2
              id="member-dialog-title"
              className="type-ui mt-2 truncate text-[var(--text)]"
            >
              {member.name}
            </h2>
            <p className="type-meta mt-0.5 truncate">{member.email}</p>
          </div>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <p className="type-meta">
            Last active {member.lastActive}
            <span className="mx-1.5 text-[var(--text-faint)]">·</span>
            {member.role === "owner"
              ? "Full workspace control"
              : member.role === "admin"
                ? "Manage members, keys, and audit"
                : member.role === "member"
                  ? "Build and operate agents"
                  : "Read-only"}
          </p>

          {canChangeRole ? (
            <label className="block">
              <span className="type-label">Role</span>
              <select
                className="ds-input mt-1.5 w-full"
                value={member.role}
                onChange={(e) => {
                  const next = e.target.value as MemberRole;
                  if (next === member.role) return;
                  onRole(member.id, next);
                  pushToast({
                    title: "Role updated",
                    body: `${member.email} → ${roleLabel(next)}`,
                    tone: "ok",
                  });
                }}
              >
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
          ) : null}

          {member.role === "owner" ? (
            <p className="type-meta">Owner cannot be demoted here.</p>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          {member.status === "invited" ? (
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              onClick={() => {
                onResend(member.id);
                pushToast({
                  title: "Invite resent",
                  body: member.email,
                  tone: "ok",
                });
              }}
            >
              Resend invite
            </button>
          ) : null}
          {member.role !== "owner" && member.status === "active" ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm !text-[var(--error)]"
              onClick={() => {
                onDisable(member.id);
                pushToast({
                  title: "Member disabled",
                  body: member.email,
                  tone: "fail",
                });
                onClose();
              }}
            >
              Disable
            </button>
          ) : null}
          {member.status === "disabled" ? (
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              onClick={() => {
                onEnable(member.id);
                pushToast({
                  title: "Member re-enabled",
                  body: member.email,
                  tone: "ok",
                });
              }}
            >
              Re-enable
            </button>
          ) : null}
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onClose}
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
