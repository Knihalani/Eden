"use client";

import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Loader2, Lock, AlertCircle, CheckCircle, ArrowLeft, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [touched, setTouched] = useState({ password: false, confirm: false });

  useEffect(() => {
    if (!token) {
      setError("Invalid or missing reset token. Please request a new password reset.");
    }
  }, [token]);

  const validatePassword = (value: string) => {
    if (!value) return null;
    if (value.length < 10) return "too-short";
    const hasUpper = /[A-Z]/.test(value);
    const hasLower = /[a-z]/.test(value);
    const hasDigit = /\d/.test(value);
    const hasSpecial = /[^A-Za-z0-9]/.test(value);
    if (hasUpper && hasLower && hasDigit && hasSpecial) return "valid";
    return "weak";
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!token) {
      setError("Invalid or missing reset token.");
      return;
    }

    if (!password || !confirmPassword) {
      setError("Please fill in all fields");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 10) {
      setError("Password must be at least 10 characters");
      return;
    }

    setLoading(true);
    try {
      await api.resetPassword({ token, password });
      setSubmitted(true);
      // Auto-redirect to login after 3 seconds
      setTimeout(() => {
        router.push("/login");
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setLoading(false);
    }
  };

  const passwordValidation = validatePassword(password);
  const passwordsMatch = password && confirmPassword && password === confirmPassword;

  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <AuthFormCard
        title="New password"
        subtitle="Create a new password for your account"
      >
        {submitted ? (
          <div className="space-y-5">
            <div className="bg-[var(--success-bg)] text-[var(--success)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--success)]/20">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              <span>Your password has been reset successfully.</span>
            </div>
            <p className="text-sm text-[var(--text-secondary)]">
              You will be redirected to the login page in a few seconds...
            </p>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 text-sm text-[var(--accent)] hover:underline font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              Go to login
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium text-[var(--text-primary)]">
                New Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] z-10" />
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                  required
                  id="password"
                  className={cn(
                    "pl-11 pr-11 h-11",
                    touched.password && passwordValidation === "too-short" && "border-[var(--error)]"
                  )}
                  placeholder="At least 10 characters"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)] p-1"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {touched.password && passwordValidation === "too-short" && (
                <p className="text-xs text-[var(--error)]">Password must be at least 10 characters</p>
              )}
              {touched.password && passwordValidation === "weak" && (
                <p className="text-xs text-[var(--warning)]">
                  Use uppercase, lowercase, number, and special character
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="confirm-password" className="text-sm font-medium text-[var(--text-primary)]">
                Confirm Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] z-10" />
                <Input
                  type={showConfirm ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, confirm: true }))}
                  required
                  id="confirm-password"
                  className={cn(
                    "pl-11 pr-11 h-11",
                    touched.confirm && confirmPassword && !passwordsMatch && "border-[var(--error)]"
                  )}
                  placeholder="Repeat your password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm(!showConfirm)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)] p-1"
                  aria-label={showConfirm ? "Hide password" : "Show password"}
                >
                  {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {touched.confirm && confirmPassword && !passwordsMatch && (
                <p className="text-xs text-[var(--error)]">Passwords do not match</p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full h-11 text-sm font-semibold"
              disabled={loading || !token || !passwordsMatch || passwordValidation !== "valid"}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Reset password"}
            </Button>

            <p className="text-center text-sm text-[var(--text-secondary)]">
              <Link href="/login" className="text-[var(--accent)] hover:underline font-medium">
                Back to login
              </Link>
            </p>
          </form>
        )}
      </AuthFormCard>
    </AuthSplitLayout>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
          <AuthFormCard title="New password" subtitle="Loading...">
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
            </div>
          </AuthFormCard>
        </AuthSplitLayout>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
