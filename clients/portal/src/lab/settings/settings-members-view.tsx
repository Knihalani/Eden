"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  roleLabel,
  type MemberFixture,
  type MemberRole,
} from "@/lab/fixtures/settings";
import { EmptyState, FilterChips } from "@/lab/lab-ui";
import { useLabToast } from "@/lab/lab-toast";
import { useConfirm } from "@/hooks/use-confirm";
import {
  MemberRoleChip,
  MemberStatusChip,
} from "@/lab/settings/settings-chrome";
import { cn } from "@/lib/utils";

type MemberFilter = "all" | "active" | "invited" | "disabled";

export type InviteOutcome = {
  member: MemberFixture;
  emailStatus: string | null;
  inviteUrl: string | null;
};

export function SettingsMembersView({
  members,
  selectedId,
  canInvite = true,
  canRemove = true,
  onSelect,
  onClose,
  onInvite,
  onRole,
  onResend,
  onRemove,
}: {
  members: MemberFixture[];
  selectedId: string | null;
  /** False for personal workspaces and non-admin roles. */
  canInvite?: boolean;
  canRemove?: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  onInvite: (email: string, role: MemberRole) => Promise<InviteOutcome>;
  onRole: (id: string, role: MemberRole) => void | Promise<void>;
  onResend: (id: string) => void;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const { pushToast } = useLabToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [filter, setFilter] = useState<MemberFilter>("all");
  const [inviting, setInviting] = useState(false);
  const inviteInputRef = useRef<HTMLInputElement>(null);

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
        {canInvite ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[12rem] flex-1">
              <span className="type-label">Invite</span>
              <input
                ref={inviteInputRef}
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
              disabled={inviting || !email.trim().includes("@")}
              title={
                email.trim().includes("@") ? undefined : "Enter a valid email"
              }
              onClick={async () => {
                setInviting(true);
                try {
                  const outcome = await onInvite(email.trim(), role);
                  setEmail("");
                  setFilter("all");
                  onSelect(outcome.member.id);
                  if (
                    outcome.emailStatus &&
                    outcome.emailStatus !== "sent"
                  ) {
                    // Backend always returns invite_url so an admin can
                    // share the link manually when email is down.
                    pushToast({
                      title: "Invite created — email not sent",
                      body: outcome.inviteUrl
                        ? `Share this link: ${outcome.inviteUrl}`
                        : `${outcome.member.email} · email delivery unavailable`,
                      tone: "accent",
                    });
                  } else {
                    pushToast({
                      title: "Invite sent",
                      body: `${outcome.member.email} · ${roleLabel(outcome.member.role)}`,
                      tone: "ok",
                    });
                  }
                } catch (err) {
                  pushToast({
                    title: "Invite failed",
                    body: err instanceof Error ? err.message : "Try again.",
                    tone: "fail",
                  });
                } finally {
                  setInviting(false);
                }
              }}
            >
              {inviting ? "Inviting…" : "Invite"}
            </button>
          </div>
        ) : (
          <p className="type-meta text-[var(--text-faint)]">
            Invites are off for this workspace.
          </p>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          compact
          title={members.length === 0 ? "No members" : "No matches"}
          body={
            members.length === 0
              ? canInvite
                ? "Invite someone to share this workspace."
                : "Just you here — this workspace has invites turned off."
              : "Try another filter."
          }
          action={
            members.length === 0 && canInvite ? (
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                onClick={() => inviteInputRef.current?.focus()}
              >
                Invite
              </button>
            ) : filter !== "all" ? (
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
          canInvite={canInvite}
          canRemove={canRemove}
          onClose={onClose}
          onRole={onRole}
          onResend={onResend}
          onRemove={onRemove}
        />
      ) : null}
    </div>
  );
}

function MemberDialog({
  member,
  canInvite,
  canRemove,
  onClose,
  onRole,
  onResend,
  onRemove,
}: {
  member: MemberFixture;
  canInvite: boolean;
  canRemove: boolean;
  onClose: () => void;
  onRole: (id: string, role: MemberRole) => void | Promise<void>;
  onResend: (id: string) => void;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const { pushToast } = useLabToast();
  const confirm = useConfirm();
  const [roleBusy, setRoleBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [removing, setRemoving] = useState(false);
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
                disabled={roleBusy}
                onChange={(e) => {
                  const next = e.target.value as MemberRole;
                  if (next === member.role) return;
                  setRoleBusy(true);
                  void (async () => {
                    try {
                      await onRole(member.id, next);
                      pushToast({
                        title: "Role updated",
                        body: `${member.email} → ${roleLabel(next)}`,
                        tone: "ok",
                      });
                    } catch {
                      /* parent toasts failure */
                    } finally {
                      setRoleBusy(false);
                    }
                  })();
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
          {member.status === "invited" && canInvite ? (
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={resending}
              onClick={() => {
                setResending(true);
                try {
                  onResend(member.id);
                } finally {
                  // Parent fires the request fire-and-forget; release
                  // the button shortly after so a rapid double-click
                  // can't stack duplicate resends.
                  window.setTimeout(() => setResending(false), 800);
                }
              }}
            >
              {resending ? "Resending…" : "Resend invite"}
            </button>
          ) : null}
          {member.role !== "owner" && member.status === "active" && canRemove ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm mr-auto text-[var(--danger)]"
              disabled={removing}
              onClick={() => {
                void (async () => {
                  const ok = await confirm(
                    `Remove ${member.email} from this workspace? They lose access immediately.`,
                  );
                  if (!ok) return;
                  setRemoving(true);
                  try {
                    await onRemove(member.id);
                    pushToast({
                      title: "Member removed",
                      body: member.email,
                      tone: "ok",
                    });
                    onClose();
                  } catch {
                    /* parent toasts failure */
                  } finally {
                    setRemoving(false);
                  }
                })();
              }}
            >
              {removing ? "Removing…" : "Remove from workspace"}
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
