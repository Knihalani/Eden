"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Loader2, Mail, AlertCircle, CheckCircle, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState(false);

  const validateEmail = (value: string) => {
    if (!value) return null;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? "valid" : "invalid";
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email) {
      setError("Please enter your email address");
      return;
    }

    setLoading(true);
    try {
      await api.forgotPassword({ email });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const emailValidation = validateEmail(email);

  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <AuthFormCard
        title="Reset password"
        subtitle="Enter your email and we'll send you a reset link"
      >
        {submitted ? (
          <div className="space-y-5">
            <div className="bg-[var(--success-bg)] text-[var(--success)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--success)]/20">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              <span>
                If an account exists with this email, you will receive a password reset link shortly.
              </span>
            </div>
            <p className="text-sm text-[var(--text-secondary)]">
              Check your inbox (and spam folder) for the reset link. Links expire in 1 hour.
            </p>
            <Link
              href="/sign-in"
              className="inline-flex items-center gap-2 text-sm text-[var(--accent)] hover:underline font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to login
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
              <label htmlFor="email" className="text-sm font-medium text-[var(--text-primary)]">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] z-10" />
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setTouched(true)}
                  required
                  id="email"
                  className={cn(
                    "pl-11 pr-10 h-11",
                    touched && emailValidation === "invalid" && "border-[var(--error)] focus:ring-[var(--error)]"
                  )}
                  placeholder="you@example.com"
                />
                {touched && emailValidation === "valid" && (
                  <CheckCircle className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--success)]" />
                )}
              </div>
              {touched && emailValidation === "invalid" && (
                <p className="text-xs text-[var(--error)]">Enter a valid email address</p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full h-11 text-sm font-semibold"
              disabled={loading || (touched && emailValidation === "invalid")}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send reset link"}
            </Button>

            <p className="text-center text-sm text-[var(--text-secondary)]">
              Remember your password?{" "}
              <Link href="/sign-in" className="text-[var(--accent)] hover:underline font-medium">
                Log in
              </Link>
            </p>
          </form>
        )}
      </AuthFormCard>
    </AuthSplitLayout>
  );
}
