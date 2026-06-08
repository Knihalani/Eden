"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Loader2, Building2, User, Mail, Clock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

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

  useEffect(() => {
    const verifyToken = async () => {
      try {
        const data = await api.verifyInviteToken(token);
        setInviteData(data);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Invalid or expired invitation";
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    if (token) {
      verifyToken();
    }
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create account";
      setSignupError(message);
    } finally {
      setSignupLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-secondary)]">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4 text-[var(--accent)]" />
          <p className="text-[var(--text-secondary)]">Verifying invitation…</p>
        </div>
      </div>
    );
  }

  if (error || !inviteData?.valid) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-secondary)]">
        <div className="max-w-md w-full mx-4 p-8 bg-[var(--surface)] rounded-2xl border border-[var(--border)] text-center">
          <div className="w-12 h-12 bg-[var(--error-bg)] rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-6 h-6 text-[var(--error)]" />
          </div>
          <h1 className="text-xl font-bold mb-2 text-[var(--text-primary)]">Invalid invitation</h1>
          <p className="text-[var(--text-secondary)] mb-6">
            {error || "This invitation link is invalid or has expired."}
          </p>
          <a
            href="/login"
            className="inline-block px-6 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg font-medium hover:bg-[var(--accent-hover)]"
          >
            Go to login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-secondary)] p-4">
      <div className="max-w-md w-full">
        <div className="p-6 bg-[var(--surface)] rounded-2xl border border-[var(--border)] mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-[var(--accent-faint)] rounded-lg flex items-center justify-center">
              <Building2 className="w-5 h-5 text-[var(--accent)]" />
            </div>
            <div>
              <h2 className="font-semibold text-lg text-[var(--text-primary)]">{inviteData.org_name}</h2>
              <p className="text-sm text-[var(--text-muted)]">has invited you to join</p>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-[var(--text-secondary)]">
              <User className="w-4 h-4 shrink-0" />
              <span>
                Invited by <strong className="text-[var(--text-primary)]">{inviteData.inviter_name}</strong>
              </span>
            </div>
            <div className="flex items-center gap-2 text-[var(--text-secondary)]">
              <Mail className="w-4 h-4 shrink-0" />
              <span>
                You will use: <strong className="text-[var(--text-primary)]">{inviteData.email}</strong>
              </span>
            </div>
            <div className="flex items-center gap-2 text-[var(--text-secondary)]">
              <Clock className="w-4 h-4 shrink-0" />
              <span>
                Expires:{" "}
                <strong className="text-[var(--text-primary)]">
                  {new Date(inviteData.expires_at).toLocaleDateString()}
                </strong>
              </span>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-[var(--border)]">
            <span
              className={cn(
                "px-3 py-1 rounded-lg text-sm font-medium",
                inviteData.role === "admin"
                  ? "bg-[var(--primary-light)] text-[var(--primary)]"
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
              )}
            >
              {inviteData.role}
            </span>
          </div>
        </div>

        <div className="p-6 bg-[var(--surface)] rounded-2xl border border-[var(--border)]">
          <h1 className="text-xl font-bold mb-1 text-[var(--text-primary)]">Create your account</h1>
          <p className="text-sm text-[var(--text-secondary)] mb-6">
            Join {inviteData.org_name} by creating your account
          </p>

          <form onSubmit={handleSignup} className="space-y-4">
            <div>
              <label htmlFor="invite-name" className="block text-sm font-medium mb-1.5 text-[var(--text-primary)]">
                Full name
              </label>
              <input
                id="invite-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Smith"
                required
                minLength={1}
                maxLength={100}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              />
            </div>

            <div>
              <label htmlFor="invite-password" className="block text-sm font-medium mb-1.5 text-[var(--text-primary)]">
                Password
              </label>
              <input
                id="invite-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
                required
                minLength={8}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              />
            </div>

            {signupError && (
              <div className="p-3 bg-[var(--error-bg)] text-[var(--error)] rounded-lg text-sm">{signupError}</div>
            )}

            <button
              type="submit"
              disabled={signupLoading || !name.trim() || !password.trim()}
              className="w-full py-2.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {signupLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              {signupLoading ? "Creating account…" : "Join organization"}
            </button>
          </form>

          <p className="text-xs text-center text-[var(--text-muted)] mt-4">
            Already have an account?{" "}
            <a href="/login" className="text-[var(--accent)] hover:underline">
              Sign in
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
