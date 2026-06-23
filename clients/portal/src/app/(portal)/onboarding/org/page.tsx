/**
 * /onboarding/org — Step 2: Create or join an organisation.
 *
 * Two paths, one menu, each a separate branch:
 *
 *   • CREATE — user picks a name, owns the new org (role: owner).
 *     The full wizard continues (install → connect → wait → done)
 *     because owners can wire up repos themselves.
 *
 *   • JOIN   — the user has three sub-paths, all leading to the
 *     same place:
 *       1. One-click accept a pending invite surfaced by
 *          `/auth/me/pending-invites` (best UX; nothing to type).
 *       2. Paste a secret token they got from email / Slack / a
 *          colleague. This is the only way to join if the invite
 *          address differs from the signed-up email, or the invite
 *          predates the account.
 *       3. (Future) Browse public orgs — not built; the docstring
 *          reserves the spot.
 *     After joining, members/viewers skip the repo step
 *     (`integrations:write` missing) so the wizard shortens.
 *
 * Why two-step state: showing both create + join in one panel is
 * the only way to keep the "have a token?" path discoverable when
 * the user has zero pending invites. A user who was invited but
 * used a different email would otherwise hit the menu and have no
 * way to redeem their token.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useOrganizationList } from "@clerk/nextjs";
import { api, onboardingApi, type PendingInvite } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { ArrowRight, Building2, KeyRound, Loader2, Mail, Plus, UserPlus } from "lucide-react";

type Branch = "menu" | "create" | "join";

export default function OnboardingOrgPage() {
  const router = useRouter();
  const toast = useToast();
  const { refreshUser } = useAuth();
  const { refreshOrgs } = useOrg();
  const { setActive } = useOrganizationList();
  const [branch, setBranch] = useState<Branch>("menu");
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pasteToken, setPasteToken] = useState("");

  // ?intent=join opens the join branch straight away so the "Joining
  // a team?" shortcut on the welcome page lands somewhere useful.
  // The deep-link is best-effort: if the user already created an
  // org, the (portal) layout will route them to /dashboard instead
  // and this page never renders. Resolved in a post-mount effect
  // rather than the ``useState`` initialiser so the SSR pass can't
  // disagree with the first client render — reading ``window`` in
  // the initialiser triggers a hydration mismatch warning in the
  // console. A single-frame flash on a deep-link is the lesser evil.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("intent") === "join") setBranch("join");
  }, []);

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
      // Server-driven create: the backend hits Clerk Backend API
      // first, then writes the Eden row with the returned
      // ``clerk_org_id``. If Clerk is unreachable the response
      // carries ``org_degraded: true`` and a null ``clerk_org_id``;
      // we surface a soft warning but proceed via Eden-only state.
      const res = await api.post<{
        org_id: string;
        name: string;
        slug: string;
        role: string;
        clerk_org_id: string | null;
        org_degraded: boolean;
      }>(`/orgs?name=${encodeURIComponent(orgName.trim())}&make_default=true`);

      // Pin the Clerk-side active org so the <OrganizationSwitcher />
      // and ``useOrganization()`` immediately see the workspace.
      // No-op when ``clerk_org_id`` is null (degraded path);
      // ``useOrg`` falls back to the Eden state in that case.
      //
      // Wrapped in try/catch because ``setActive`` can throw if the
      // Clerk membership webhook hasn't propagated yet (race between
      // our backend's ``create_membership`` call and Clerk's
      // session refresh). A failure here doesn't block the local
      // join — the user can still proceed through the wizard.
      if (res.clerk_org_id && setActive) {
        try {
          await setActive({ organization: res.clerk_org_id });
        } catch (err) {
          toast.error(
            err instanceof Error
              ? `Workspace created but Clerk sync is still propagating: ${err.message}. Some features may be temporarily unavailable.`
              : "Workspace created but Clerk sync is still propagating. Some features may be temporarily unavailable.",
          );
        }
      }
      if (res.org_degraded) {
        toast.error(
          "Organisation created but Clerk sync is degraded; some features may be unavailable until sync resumes",
        );
      }

      await refreshUser();
      await refreshOrgs();
      await onboardingApi.patchState(res.org_id, {
        step: "autonomous",
        org_setup_choice: "created",
      });
      if (typeof window !== "undefined") {
        window.localStorage.removeItem("eden:onboarding:skipRepo");
      }
      toast.success(`Created ${res.name} — you're the owner`);
      router.push("/onboarding/autonomous");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create org");
    } finally {
      setSubmitting(false);
    }
  }

  async function acceptInvite(inv: PendingInvite) {
    setSubmitting(true);
    try {
      const res = await api.post<{
        message: string;
        org_id: string;
        role: string;
        clerk_org_id: string | null;
      }>(`/orgs/${inv.org_id}/invites/${inv.invitation_id}/accept`);
      if (res.clerk_org_id && setActive) {
        try {
          await setActive({ organization: res.clerk_org_id });
        } catch {
          // ``setActive`` can throw on the webhook-propagation race;
          // the local join still succeeded, so we continue.
        }
      }
      await refreshUser();
      await refreshOrgs();
      await onboardingApi.patchState(inv.org_id, {
        step: "autonomous",
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
      router.push("/onboarding/autonomous");
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
      // The accept-by-token endpoint mirrors the per-org accept route
      // but takes the secret token directly. It is the only way to
      // join when the invite address differs from the signed-up email
      // (the /auth/me/pending-invites query filters by email).
      const res = await api.post<{
        org_id: string;
        role: string;
        org_name: string;
        clerk_org_id: string | null;
      }>(`/auth/invitations/accept?token=${encodeURIComponent(pasteToken.trim())}`);
      if (res.clerk_org_id && setActive) {
        try {
          await setActive({ organization: res.clerk_org_id });
        } catch {
          // See comment in acceptInvite above.
        }
      }
      await refreshUser();
      await refreshOrgs();
      await onboardingApi.patchState(res.org_id, {
        step: "autonomous",
        org_setup_choice: "joined",
      });
      const canIntegrate = res.role === "owner" || res.role === "admin";
      if (typeof window !== "undefined") {
        if (canIntegrate) {
          window.localStorage.removeItem("eden:onboarding:skipRepo");
        } else {
          window.localStorage.setItem("eden:onboarding:skipRepo", "1");
        }
      }
      toast.success(`Joined ${res.org_name} as ${res.role}`);
      router.push("/onboarding/autonomous");
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
              Review &amp; join →
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

        <p className="text-xs text-[var(--text-muted)]">
          No invite and no token? Ask an Eden admin to send you one
          from <span className="font-mono">Settings → Members</span>.
        </p>
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
          Three ways in: pick a pending invite, paste a token, or ask
          an admin to send one to your account email.
        </p>
      </div>

      {/* Pending invites — surfaced from /auth/me/pending-invites. */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-[var(--text-secondary)]">
          Pending invites
        </h2>
        {loadingInvites ? (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 text-sm text-[var(--text-muted)]">
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
                    {inv.expires_at
                      ? ` · expires ${new Date(inv.expires_at).toLocaleDateString()}`
                      : ""}
                  </div>
                </div>
                <ArrowRight className="mt-1 h-5 w-5 text-[var(--text-muted)]" />
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 text-sm text-[var(--text-muted)]">
            No pending invites on file. If a teammate sent you one,
            check the email address on your account, or paste the
            token below.
          </div>
        )}
      </section>

      {/* Token paste — the only way to join if invites filter out
          your email (e.g. you signed up with a different address) or
          the invite predates the account. Always visible. */}
      <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
        <label className="mb-2 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <KeyRound className="h-4 w-4 text-[var(--accent)]" />
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
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Join"}
          </button>
        </div>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          Tokens look like <span className="font-mono">aB12-cdEf…</span>.
          They expire after 7 days; ask your admin for a fresh one if
          yours is stale.
        </p>
      </section>

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
