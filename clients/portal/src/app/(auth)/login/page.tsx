"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { Loader2, Mail, Lock, AlertCircle, CheckCircle, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthSplitLayout, AuthBrandPanel, AuthFormCard } from "@/components/auth";

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState({ email: false, password: false });

  const validateEmail = (value: string) => {
    if (!value) return null;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? "valid" : "invalid";
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email || !password) {
      setError("Please fill in all fields");
      return;
    }

    setLoading(true);
    try {
      await login(email, password);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const emailValidation = validateEmail(email);

  return (
    <AuthSplitLayout brandPanel={<AuthBrandPanel />}>
      <AuthFormCard
        title="Log in"
        subtitle="Enter your credentials to continue"
      >
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
                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                required
                id="email"
                className={cn(
                  "pl-11 pr-10 h-11",
                  touched.email && emailValidation === "invalid" && "border-[var(--error)] focus:ring-[var(--error)]"
                )}
                placeholder="you@example.com"
              />
              {touched.email && emailValidation === "valid" && (
                <CheckCircle className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--success)]" />
              )}
            </div>
            {touched.email && emailValidation === "invalid" && (
              <p className="text-xs text-[var(--error)]">Enter a valid email address</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium text-[var(--text-primary)]">
              Password
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
                className="pl-11 pr-11 h-11"
                placeholder="Enter your password"
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
          </div>

          <Button
            type="submit"
            className="w-full h-11 text-sm font-semibold"
            disabled={loading || (touched.email && emailValidation === "invalid")}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Log in"}
          </Button>
        </form>

        <p className="text-center text-sm text-[var(--text-secondary)] mt-6">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="text-[var(--accent)] hover:underline font-medium">
            Sign up
          </Link>
        </p>
      </AuthFormCard>
    </AuthSplitLayout>
  );
}
