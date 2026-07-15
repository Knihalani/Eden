"use client";

/**
 * Clerk-native invite accept landing.
 *
 * Soft-launch: portal auth is Clerk. New invitees sign up / sign in
 * with Clerk, then accept the Eden invitation token while signed in.
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { SignInButton, SignUpButton, useAuth } from "@clerk/nextjs";
import { api } from "@/lib/api";
import {
  Loader2,
  Building2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

export default function InvitePage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;
  const { isSignedIn, isLoaded } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    try {
      const data = await api.verifyInviteToken(token);
      setInviteData(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid or expired invitation";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) void verifyToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  if (error || !inviteData?.valid) {
    return (
      <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
        <AuthFormCard title="Invalid invitation" subtitle="This invitation link couldn't be verified">
          <div className="space-y-5 text-center">
            <div
              role="alert"
              className="bg-[var(--error-dim)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20 text-left"
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              <span>{error || "This invitation link is invalid or has expired."}</span>
            </div>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-2">
              <Button type="button" variant="outline" onClick={() => void verifyToken()}>
                <RefreshCw className="w-4 h-4" />
                Try again
              </Button>
              <Link
                href="/sign-in"
                className="inline-flex items-center justify-center gap-2 px-4 h-10 rounded-lg bg-[var(--accent)] text-[var(--accent-foreground)] text-sm font-medium"
              >
                Go to login
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
                accept this invitation.
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <SignUpButton mode="modal">
                  <Button className="w-full">Create account</Button>
                </SignUpButton>
                <SignInButton mode="modal">
                  <Button variant="outline" className="w-full">
                    Sign in
                  </Button>
                </SignInButton>
              </div>
            </>
          ) : (
            <>
              {acceptError && (
                <p role="alert" className="text-sm text-[var(--error)]">
                  {acceptError}
                </p>
              )}
              <Button
                className="w-full"
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
