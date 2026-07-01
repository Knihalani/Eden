"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import {
  Loader2,
  Building2,
  User,
  Mail,
  Clock,
  AlertCircle,
  ArrowLeft,
  RefreshCw,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

export default function InvitePage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

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

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [signupLoading, setSignupLoading] = useState(false);
  const [signupError, setSignupError] = useState<string | null>(null);

  const verifyToken = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.verifyInviteToken(token);
      setInviteData(data);
    } catch (err) {
      // Strongly-typed catch: instanceof Error guard, fallback for
      // non-Error throws (e.g. network errors that stringified).
      const message = err instanceof Error ? err.message : "Invalid or expired invitation";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) {
      verifyToken();
    }
    // verifyToken captures token from the closure; we explicitly
    // re-create on `token` change so a route change re-validates.
     
  }, [token]);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !password.trim()) return;

    setSignupLoading(true);
    setSignupError(null);

    try {
      const result = await api.signupFromInvite({
        token,
        password,
        name,
      });

      router.push(`/dashboard?org=${result.org_id}`);
    } catch (err) {
      // Same strongly-typed guard as verifyToken above.
      const message = err instanceof Error ? err.message : "Failed to create account";
      setSignupError(message);
    } finally {
      setSignupLoading(false);
    }
  };

  // Loading state — render inside the same split-layout chrome so
  // the layout doesn't shift when the token resolves.
  if (loading) {
    return (
      <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
        <AuthFormCard title="Verifying invitation" subtitle="One moment…">
          <div
            className="flex items-center justify-center py-8"
            aria-busy="true"
            aria-live="polite"
          >
            <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
          </div>
        </AuthFormCard>
      </AuthSplitLayout>
    );
  }

  // Error / invalid state — offer a retry so a transient network
  // blip doesn't strand the user.
  if (error || !inviteData?.valid) {
    return (
      <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
        <AuthFormCard
          title="Invalid invitation"
          subtitle="This invitation link couldn't be verified"
        >
          <div className="space-y-5 text-center">
            <div
              role="alert"
              className="bg-[var(--error-dim)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20 text-left"
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              <span>
                {error || "This invitation link is invalid or has expired."}
              </span>
            </div>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={verifyToken}
                disabled={loading}
                loading={loading}
                aria-label="Retry invitation verification"
              >
                <RefreshCw className="w-4 h-4" />
                Try again
              </Button>
              <Link
                href="/sign-in"
                className="inline-flex items-center justify-center gap-2 px-4 h-10 rounded-lg bg-[var(--accent)] text-[var(--accent-foreground)] text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
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
      <div className="w-full max-w-md space-y-4">
        {/* Org invitation summary card */}
        <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[var(--accent-faint)] rounded-lg flex items-center justify-center shrink-0">
              <Building2 className="w-5 h-5 text-[var(--accent)]" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
                Organization invitation
              </p>
              <h2 className="font-semibold text-lg text-[var(--text-primary)] truncate">
                {inviteData.org_name}
              </h2>
            </div>
          </div>

          <div className="mt-4 space-y-2 text-sm">
            <div className="flex items-center gap-2 text-[var(--text-secondary)]">
              <User className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>
                Invited by{" "}
                <strong className="text-[var(--text-primary)]">
                  {inviteData.inviter_name}
                </strong>
              </span>
            </div>
            <div className="flex items-center gap-2 text-[var(--text-secondary)]">
              <Mail className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>
                You will use:{" "}
                <strong className="text-[var(--text-primary)]">{inviteData.email}</strong>
              </span>
            </div>
            <div className="flex items-center gap-2 text-[var(--text-secondary)]">
              <Clock className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>
                Expires:{" "}
                <strong className="text-[var(--text-primary)]">
                  {new Date(inviteData.expires_at).toLocaleDateString()}
                </strong>
              </span>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-[var(--border-subtle)]">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium",
                inviteData.role === "admin"
                  ? "bg-[var(--accent-faint)] text-[var(--accent)] border border-[var(--accent)]/20"
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border border-[var(--border-subtle)]"
              )}
            >
              <Shield className="w-3 h-3" aria-hidden="true" />
              {inviteData.role}
            </span>
          </div>
        </div>

        <AuthFormCard
          title="Create your account"
          subtitle={`Join ${inviteData.org_name} by setting your name and password`}
        >
          <form onSubmit={handleSignup} className="space-y-4" noValidate>
            <div className="space-y-2">
              <label
                htmlFor="invite-name"
                className="text-sm font-medium text-[var(--text-primary)]"
              >
                Full name
              </label>
              <Input
                id="invite-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Smith"
                required
                minLength={1}
                maxLength={100}
                autoComplete="name"
                aria-label="Full name"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="invite-password"
                className="text-sm font-medium text-[var(--text-primary)]"
              >
                Password
              </label>
              <Input
                id="invite-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
                required
                minLength={8}
                autoComplete="new-password"
                aria-label="Password"
              />
            </div>

            {signupError && (
              <div
                role="alert"
                className="bg-[var(--error-dim)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                {signupError}
              </div>
            )}

            <Button
              type="submit"
              className="w-full h-11 text-sm font-semibold"
              disabled={signupLoading || !name.trim() || !password.trim()}
              loading={signupLoading}
              aria-label="Join organization"
            >
              {signupLoading ? "Creating account…" : "Join organization"}
            </Button>
          </form>

          <p className="text-xs text-center text-[var(--text-muted)] mt-4">
            Already have an account?{" "}
            <Link href="/sign-in" className="text-[var(--accent)] hover:underline">
              Sign in
            </Link>
          </p>

          <p className="text-xs text-center text-[var(--text-faint)] mt-2">
            <Link
              href="/"
              className="inline-flex items-center gap-1 hover:text-[var(--text-muted)] transition-colors"
            >
              <ArrowLeft className="w-3 h-3" aria-hidden="true" />
              Back to home
            </Link>
          </p>
        </AuthFormCard>
      </div>
    </AuthSplitLayout>
  );
}
