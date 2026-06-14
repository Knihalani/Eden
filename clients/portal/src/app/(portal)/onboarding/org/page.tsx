/**
 * /onboarding/org — Step 2: Create or join an organisation
 *
 * Two branches:
 *
 *   • CREATE — user picks a name, owns the new org (role: owner).
 *     Lands on the next step with full repo-link access.
 *
 *   • JOIN   — user picks from pending invites (or pastes a token).
 *     Their role is set by the inviter. If they join as
 *     member/viewer, the repo-link step is SKIPPED — repo
 *     integration requires `integrations:write`, which only
 *     owners and admins have. We persist a localStorage flag
 *     `eden:onboarding:skipRepo=1` so the layout's progress
 *     bar reflects the shorter path.
 *
 * Why a localStorage flag rather than server state: the layout is a
 * client component and we want the progress bar to be correct on the
 * VERY FIRST render after joining (no network round trip). The server
 * is still the source of truth (onboarding_state.org_setup_choice).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, onboardingApi, type PendingInvite } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { ArrowRight, Building2, Loader2, Mail, Plus, UserPlus } from "lucide-react";

type Branch = "menu" | "create" | "join";

export default function OnboardingOrgPage() {
  const router = useRouter();
  const toast = useToast();
  const { refreshUser } = useAuth();
  const { refreshOrgs } = useOrg();
  const [branch, setBranch] = useState<Branch>("menu");
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pasteToken, setPasteToken] = useState("");

  const loadInvites = useCallback(async () => {
    setLoadingInvites(true);
    try {
      const list = await onboardingApi.pendingInvites();
      setInvites(list);
    } catch {
      // Empty list is the same UX as a failure — surface nothing.
    } finally {
      setLoadingInvites(false);
    }
  }, []);

  useEffect(() => {
    loadInvites();
  }, [loadInvites]);

  async function createOrg() {
    if (orgName.trim().length < 2) {
      toast.error("Organisation name must be at least 2 characters");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post<{ org_id: string; name: string; slug: string; role: string }>(
        `/orgs?name=${encodeURIComponent(orgName.trim())}&make_default=true`,
      );
      await refreshUser();
      await refreshOrgs();
      await onboardingApi.patchState(res.org_id, {
        step: "install_sdk",
        org_setup_choice: "created",
      });
      if (typeof window !== "undefined") {
        window.localStorage.removeItem("eden:onboarding:skipRepo");
      }
      toast.success(`Created ${res.name} — you're the owner`);
      router.push("/onboarding/install");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create org");
    } finally {
      setSubmitting(false);
    }
  }

  async function acceptInvite(inv: PendingInvite) {
    setSubmitting(true);
    try {
      await api.post(
        `/orgs/${inv.org_id}/invites/${inv.invitation_id}/accept`,
      );
      await refreshUser();
      await refreshOrgs();
      await onboardingApi.patchState(inv.org_id, {
        step: "install_sdk",
        org_setup_choice: "joined",
      });
      // Joined users without integrations:write skip the repo step.
      const canIntegrate = inv.role === "owner" || inv.role === "admin";
      if (typeof window !== "undefined") {
        if (canIntegrate) {
          window.localStorage.removeItem("eden:onboarding:skipRepo");
        } else {
          window.localStorage.setItem("eden:onboarding:skipRepo", "1");
        }
      }
      toast.success(`Joined ${inv.org_name} as ${inv.role}`);
      router.push("/onboarding/install");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to accept invite");
    } finally {
      setSubmitting(false);
    }
  }

  async function acceptByToken() {
    if (!pasteToken.trim()) {
      toast.error("Paste an invitation token first");
      return;
    }
    setSubmitting(true);
    try {
      // The accept-by-token endpoint mirrors the per-org accept route.
      const res = await api.post<{ org_id: string; role: string }>(
        `/auth/invitations/accept?token=${encodeURIComponent(pasteToken.trim())}`,
      );
      await refreshUser();
      await refreshOrgs();
      await onboardingApi.patchState(res.org_id, {
        step: "install_sdk",
        org_setup_choice: "joined",
      });
      const canIntegrate = res.role === "owner" || res.role === "admin";
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          "eden:onboarding:skipRepo",
          canIntegrate ? "" : "1",
        );
      }
      toast.success("Invitation accepted");
      router.push("/onboarding/install");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invalid or expired invite");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────

  if (branch === "menu") {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Set up your organisation</h1>
          <p className="mt-2 text-[var(--text-secondary)]">
            Eden groups traces, agents, and integrations by org. You
            can be in many at once and switch from the sidebar.
          </p>
        </div>

        {invites.length > 0 && (
          <div className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-faint)] p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--accent)]">
              <Mail className="h-4 w-4" />
              You have {invites.length} pending invite{invites.length === 1 ? "" : "s"}
            </div>
            <button
              onClick={() => setBranch("join")}
              className="text-sm underline hover:text-[var(--accent)]"
            >
              Join an existing organisation →
            </button>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <button
            onClick={() => setBranch("create")}
            className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-6 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
          >
            <Plus className="mb-3 h-6 w-6 text-[var(--accent)]" />
            <div className="text-lg font-semibold">Create new organisation</div>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              You become the owner with full permissions, including
              connecting GitHub repos and opening integration PRs.
            </p>
          </button>
          <button
            onClick={() => setBranch("join")}
            className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-6 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
          >
            <UserPlus className="mb-3 h-6 w-6 text-[var(--accent)]" />
            <div className="text-lg font-semibold">Join existing organisation</div>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Accept a pending invite or paste a token. Your role is
              set by whoever invited you — members and viewers can&apos;t
              connect repos directly.
            </p>
          </button>
        </div>
      </div>
    );
  }

  if (branch === "create") {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Create your organisation</h1>
          <p className="mt-2 text-[var(--text-secondary)]">
            Pick something you&apos;ll recognise on the sidebar. You can
            rename it later from Settings.
          </p>
        </div>
        <div>
          <label className="mb-1 block text-sm text-[var(--text-secondary)]">
            Organisation name
          </label>
          <input
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Acme AI Labs"
            maxLength={100}
            className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            autoFocus
          />
        </div>
        <div className="flex items-center justify-between">
          <button
            onClick={() => setBranch("menu")}
            className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ← Back
          </button>
          <button
            onClick={createOrg}
            disabled={submitting || orgName.trim().length < 2}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}
            Create &amp; continue
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  // branch === "join"
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Join an organisation</h1>
        <p className="mt-2 text-[var(--text-secondary)]">
          {invites.length > 0
            ? "Pick one of the pending invites below, or paste a token."
            : "Paste the invitation token your admin sent you."}
        </p>
      </div>

      {loadingInvites ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Looking for pending invites…
        </div>
      ) : invites.length > 0 ? (
        <div className="space-y-2">
          {invites.map((inv) => (
            <button
              key={inv.invitation_id}
              onClick={() => acceptInvite(inv)}
              disabled={submitting}
              className="flex w-full items-start justify-between rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              <div>
                <div className="text-base font-semibold">{inv.org_name}</div>
                <div className="mt-1 text-xs text-[var(--text-muted)]">
                  Invited by {inv.invited_by_name || inv.invited_by_email}
                  {" · role "}
                  <span className="font-mono">{inv.role}</span>
                </div>
              </div>
              <ArrowRight className="mt-1 h-5 w-5 text-[var(--text-muted)]" />
            </button>
          ))}
        </div>
      ) : null}

      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
        <label className="mb-1 block text-sm text-[var(--text-secondary)]">
          Have a token from email?
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={pasteToken}
            onChange={(e) => setPasteToken(e.target.value)}
            placeholder="paste-your-invite-token-here"
            className="flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <button
            onClick={acceptByToken}
            disabled={submitting || !pasteToken.trim()}
            className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50"
          >
            Join
          </button>
        </div>
      </div>

      <div>
        <button
          onClick={() => setBranch("menu")}
          className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          ← Back
        </button>
      </div>
    </div>
  );
}
