"use client";

/**
 * Clerk-native invite accept landing.
 *
 * Soft-launch: portal auth is Clerk. New invitees sign up / sign in
 * with Clerk, then accept the Eden invitation token while signed in.
 * Accepting joins the invited org — it does not create an org via tour.
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  SignInButton,
  SignUpButton,
  useAuth,
  useClerk,
  useOrganizationList,
  useUser,
} from "@clerk/nextjs";
import { api, ApiError } from "@/lib/api";
import {
  Loader2,
  Building2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

type InviteFailureKind = "expired" | "invalid" | "unavailable";

function signedInPrimaryEmail(user: {
  primaryEmailAddress?: { emailAddress?: string | null } | null;
  emailAddresses?: Array<{ emailAddress?: string | null }>;
} | null | undefined): string {
  const primary = user?.primaryEmailAddress?.emailAddress?.trim() ?? "";
  if (primary) return primary.toLowerCase();
  const first = user?.emailAddresses?.[0]?.emailAddress?.trim() ?? "";
  return first.toLowerCase();
}

function classifyInviteFailure(err: unknown): {
  kind: InviteFailureKind;
  title: string;
  subtitle: string;
  detail: string;
} {
  const status =
    err instanceof ApiError
      ? err.status
      : typeof err === "object" &&
          err !== null &&
          "status" in err &&
          typeof (err as { status?: unknown }).status === "number"
        ? (err as { status: number }).status
        : undefined;
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Invalid or expired invitation";

  const lower = message.toLowerCase();
  const networkish =
    status !== undefined && status >= 500
      ? true
      : /failed to fetch|network|econnrefused|timeout|unreachable|bad gateway|503|502|504|trouble reaching/i.test(
          lower,
        );

  if (networkish) {
    return {
      kind: "unavailable",
      title: "Couldn’t verify invitation",
      subtitle: "Eden couldn’t reach the API to check this link",
      detail:
        "Try again in a moment. If it keeps failing, ask your teammate to resend the invite.",
    };
  }

  // Backend returns a single 404 detail for both expired and unknown
  // tokens ("Invalid or expired…"). Prefer "expired" when the copy
  // says so; otherwise treat as invalid/used.
  if (/expir/i.test(lower) && !/invalid or expired/i.test(lower)) {
    return {
      kind: "expired",
      title: "Invitation expired",
      subtitle: "This invite link is no longer valid",
      detail:
        "Ask your teammate to send a new invitation from Organization settings.",
    };
  }

  if (/expir/i.test(lower)) {
    return {
      kind: "expired",
      title: "Invitation invalid or expired",
      subtitle: "This invite link can’t be used",
      detail:
        "It may have expired, already been accepted, or been typed incorrectly. Ask your teammate for a fresh link.",
    };
  }

  return {
    kind: "invalid",
    title: "Invalid invitation",
    subtitle: "This invitation link couldn’t be verified",
    detail:
      message ||
      "This invitation link is invalid. Ask your teammate to send a new one.",
  };
}

export default function InvitePage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const { user, isLoaded: userLoaded } = useUser();
  const { signOut } = useClerk();
  const { setActive: setActiveOrg, isLoaded: orgListLoaded } = useOrganizationList();
  const signedInEmail = signedInPrimaryEmail(user);

  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<ReturnType<typeof classifyInviteFailure> | null>(
    null,
  );
  const [inviteData, setInviteData] = useState<{
    valid: boolean;
    org_name: string;
    role: string;
    inviter_name: string;
    expires_at: string;
    email: string;
  } | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [joinedDegraded, setJoinedDegraded] = useState<{
    org_name: string;
    role: string;
  } | null>(null);

  const verifyToken = async () => {
    setLoading(true);
    setFailure(null);
    try {
      const data = await api.verifyInviteToken(token);
      if (!data.valid) {
        const expiresAt = data.expires_at ? new Date(data.expires_at) : null;
        const expired = expiresAt !== null && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < Date.now();
        setFailure(
          classifyInviteFailure(
            expired
              ? "Invitation expired"
              : "Invalid invitation",
          ),
        );
        setInviteData(null);
        return;
      }
      setInviteData(data);
    } catch (err) {
      setFailure(classifyInviteFailure(err));
      setInviteData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) void verifyToken();
  }, [token]);

  const handleSwitchAccount = async () => {
    try {
      setSwitchingAccount(true);
      // Sign out then return here — /sign-in while already signed in
      // bounces to /dashboard and drops the invite token (dead end).
      await signOut({ redirectUrl: `/invite/${token}` });
    } catch {
      setSwitchingAccount(false);
      setAcceptError("Could not sign out. Try again, then sign in with the invited email.");
    }
  };

  const handleAccept = async () => {
    try {
      setAccepting(true);
      setAcceptError(null);
      const accepted = await api.acceptInviteByToken(token);
      // Activate the joined Clerk org before dashboard chrome mounts.
      // Auth routes are outside OrgProvider, so Eden setCurrentOrg /
      // refreshOrgs are unavailable here — setActive is the handoff;
      // portal OrgProvider remaps via /auth/me on the next page.
      if (accepted.clerk_org_id) {
        if (!orgListLoaded || !setActiveOrg) {
          throw new Error(
            "Organization switcher is still loading. Wait a moment and try again so you land in the invited workspace.",
          );
        }
        await setActiveOrg({ organization: accepted.clerk_org_id });
        router.push("/dashboard");
        return;
      }
      // Clerk sync degraded: Eden membership exists but session org
      // cannot be activated — do not silently dump into the wrong org.
      setJoinedDegraded({
        org_name: accepted.org_name || inviteData?.org_name || "the organization",
        role: accepted.role || inviteData?.role || "member",
      });
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : "Failed to accept invitation");
    } finally {
      setAccepting(false);
    }
  };

  // Auth + user must be loaded before email-mismatch vs accept UI.
  // Otherwise an empty signedInEmail skips the mismatch gate and
  // briefly exposes Accept for the wrong account.
  const sessionReady = authLoaded && (!isSignedIn || userLoaded);
  if (loading || !sessionReady) {
    return (
      <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
        <AuthFormCard title="Verifying invitation" subtitle="One moment…">
          <div className="flex items-center justify-center py-8" aria-busy="true" aria-live="polite">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
          </div>
        </AuthFormCard>
      </AuthSplitLayout>
    );
  }

  if (joinedDegraded) {
    return (
      <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
        <AuthFormCard
          title={`Joined ${joinedDegraded.org_name}`}
          subtitle={`You joined as ${joinedDegraded.role}, but workspace activation is delayed`}
        >
          <div className="space-y-space-5">
            <ErrorState
              title="Workspace activation delayed"
              message={`You’re a ${joinedDegraded.role} in ${joinedDegraded.org_name}, but Clerk could not activate that workspace yet. Open the dashboard and pick it from the organization switcher.`}
              action={
                <Link
                  href="/dashboard"
                  className="inline-flex min-h-11 items-center justify-center gap-space-2 px-space-4 rounded-lg bg-[var(--accent)] text-[var(--accent-foreground)] text-sm font-medium"
                >
                  Continue to dashboard
                </Link>
              }
            />
          </div>
        </AuthFormCard>
      </AuthSplitLayout>
    );
  }

  if (failure || !inviteData?.valid) {
    const ui = failure ?? classifyInviteFailure("Invalid or expired invitation");
    return (
      <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
        <AuthFormCard title={ui.title} subtitle={ui.subtitle}>
          <div className="space-y-space-5">
            <ErrorState
              title={ui.title}
              message={ui.detail}
              action={
                <div className="flex flex-col sm:flex-row items-center justify-center gap-space-2">
                  <Button type="button" variant="outline" className="min-h-11" onClick={() => void verifyToken()}>
                    <RefreshCw className="w-4 h-4" />
                    {ui.kind === "unavailable" ? "Try again" : "Check again"}
                  </Button>
                  <Link
                    href="/sign-in"
                    className="inline-flex min-h-11 items-center justify-center gap-space-2 px-space-4 rounded-lg bg-[var(--accent)] text-[var(--accent-foreground)] text-sm font-medium"
                  >
                    Go to sign in
                  </Link>
                </div>
              }
            />
          </div>
        </AuthFormCard>
      </AuthSplitLayout>
    );
  }

  const inviteEmail = (inviteData.email || "").trim().toLowerCase();
  const emailMismatch =
    Boolean(isSignedIn) &&
    Boolean(inviteEmail) &&
    Boolean(signedInEmail) &&
    signedInEmail !== inviteEmail;

  if (emailMismatch) {
    return (
      <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
        <AuthFormCard
          title="Wrong account for this invite"
          subtitle="Signed-in email does not match the invitation"
        >
          <div className="space-y-space-5">
            <ErrorState
              title="Wrong account for this invite"
              message={`This invitation was sent to ${inviteData.email}, but you are signed in as ${signedInEmail}. Sign out and sign in with the invited email to accept.`}
              action={
                <div className="flex flex-col sm:flex-row items-center justify-center gap-space-2">
                  <Button
                    type="button"
                    className="min-h-11"
                    loading={switchingAccount}
                    onClick={() => void handleSwitchAccount()}
                  >
                    Switch account
                  </Button>
                </div>
              }
            />
          </div>
        </AuthFormCard>
      </AuthSplitLayout>
    );
  }

  const acceptBlockedByOrgList = Boolean(isSignedIn) && !orgListLoaded;

  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <AuthFormCard
        title={`Join ${inviteData.org_name}`}
        subtitle={`${inviteData.inviter_name} invited you as ${inviteData.role}`}
      >
        <div className="space-y-space-5">
          <div className="flex items-start gap-space-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-space-4">
            <Building2 className="w-5 h-5 text-[var(--accent)] mt-0.5" aria-hidden />
            <div className="text-sm text-[var(--text-secondary)]">
              <p className="font-medium text-[var(--text-primary)]">{inviteData.org_name}</p>
              <p className="mt-1">Invited email: {inviteData.email}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Expires {new Date(inviteData.expires_at).toLocaleString()}
              </p>
            </div>
          </div>

          {!isSignedIn ? (
            <>
              <p className="text-sm text-[var(--text-secondary)]">
                Sign in or create an account with <strong>{inviteData.email}</strong>, then
                accept to join this organization.
              </p>
              <div className="flex flex-col sm:flex-row gap-space-2">
                <SignUpButton
                  mode="modal"
                  forceRedirectUrl={`/invite/${token}`}
                  fallbackRedirectUrl={`/invite/${token}`}
                >
                  <Button className="w-full min-h-11">Create account</Button>
                </SignUpButton>
                <SignInButton
                  mode="modal"
                  forceRedirectUrl={`/invite/${token}`}
                  fallbackRedirectUrl={`/invite/${token}`}
                >
                  <Button variant="outline" className="w-full min-h-11">
                    Sign in
                  </Button>
                </SignInButton>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-[var(--text-secondary)]">
                Accepting adds you to <strong>{inviteData.org_name}</strong> as{" "}
                <strong>{inviteData.role}</strong>. It does not create a new organization.
              </p>
              {acceptBlockedByOrgList && (
                <p className="text-sm text-[var(--text-muted)]" aria-live="polite">
                  Preparing organization switcher…
                </p>
              )}
              {acceptError && (
                <ErrorState
                  size="sm"
                  title="Could not accept invitation"
                  message={acceptError}
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      loading={accepting}
                      disabled={acceptBlockedByOrgList}
                      onClick={() => void handleAccept()}
                    >
                      <RefreshCw className="w-4 h-4" />
                      Try again
                    </Button>
                  }
                />
              )}
              <Button
                className="w-full min-h-11"
                loading={accepting || acceptBlockedByOrgList}
                disabled={acceptBlockedByOrgList}
                onClick={() => void handleAccept()}
              >
                Accept invitation
              </Button>
            </>
          )}
        </div>
      </AuthFormCard>
    </AuthSplitLayout>
  );
}
