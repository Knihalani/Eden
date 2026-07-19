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
import { SignInButton, SignUpButton, useAuth } from "@clerk/nextjs";
import { api, ApiError } from "@/lib/api";
import {
  Loader2,
  Building2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

type InviteFailureKind = "expired" | "invalid" | "unavailable";

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
  const { isSignedIn, isLoaded } = useAuth();

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

  const handleAccept = async () => {
    try {
      setAccepting(true);
      setAcceptError(null);
      const accepted = await api.acceptInviteByToken(token);
      router.push(`/dashboard?org=${accepted.org_id}`);
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : "Failed to accept invitation");
    } finally {
      setAccepting(false);
    }
  };

  if (loading || !isLoaded) {
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

  if (failure || !inviteData?.valid) {
    const ui = failure ?? classifyInviteFailure("Invalid or expired invitation");
    return (
      <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
        <AuthFormCard title={ui.title} subtitle={ui.subtitle}>
          <div className="space-y-5 text-center">
            <div
              role="alert"
              className="bg-[var(--error-dim)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20 text-left"
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              <span>{ui.detail}</span>
            </div>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-2">
              {ui.kind === "unavailable" ? (
                <Button type="button" variant="outline" className="min-h-11" onClick={() => void verifyToken()}>
                  <RefreshCw className="w-4 h-4" />
                  Try again
                </Button>
              ) : (
                <Button type="button" variant="outline" className="min-h-11" onClick={() => void verifyToken()}>
                  <RefreshCw className="w-4 h-4" />
                  Check again
                </Button>
              )}
              <Link
                href="/sign-in"
                className="inline-flex min-h-11 items-center justify-center gap-2 px-4 rounded-lg bg-[var(--accent)] text-[var(--accent-foreground)] text-sm font-medium"
              >
                Go to sign in
              </Link>
            </div>
          </div>
        </AuthFormCard>
      </AuthSplitLayout>
    );
  }

  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <AuthFormCard
        title={`Join ${inviteData.org_name}`}
        subtitle={`${inviteData.inviter_name} invited you as ${inviteData.role}`}
      >
        <div className="space-y-5">
          <div className="flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4">
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
              <div className="flex flex-col sm:flex-row gap-2">
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
                Accepting adds you to <strong>{inviteData.org_name}</strong>. It does not
                create a new organization.
              </p>
              {acceptError && (
                <p role="alert" className="text-sm text-[var(--error)]">
                  {acceptError}
                </p>
              )}
              <Button
                className="w-full min-h-11"
                loading={accepting}
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
