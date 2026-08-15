"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthMessageCard } from "@/components/auth";
import { API_BASE } from "@/lib/api/core";

type State =
  | { kind: "verifying" }
  | { kind: "success" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function VerifyEmailPanel() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<State>(
    token ? { kind: "verifying" } : { kind: "missing" },
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/auth/verify-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        if (resp.ok) {
          setState({ kind: "success" });
        } else {
          setState({
            kind: "error",
            message:
              "This verification link is invalid or has expired. Sign in and request a fresh verification email.",
          });
        }
      } catch {
        if (!cancelled) {
          setState({
            kind: "error",
            message:
              "We could not reach the server to verify your address. Check your connection and try the link again.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === "missing") {
    return (
      <AuthMessageCard
        title="Verify your email"
        body="This page completes email verification from a link in your inbox. If you were expecting a verification email, open the link in that email."
        ctaHref="/sign-in"
        ctaLabel="Go to sign in"
      />
    );
  }
  if (state.kind === "verifying") {
    return (
      <AuthMessageCard
        title="Verifying…"
        body="Confirming your email address."
        ctaHref="/sign-in"
        ctaLabel="Go to sign in"
      />
    );
  }
  if (state.kind === "success") {
    return (
      <AuthMessageCard
        title="Email verified"
        body="Your email address is verified. You can sign in now."
        ctaHref="/sign-in"
        ctaLabel="Go to sign in"
      />
    );
  }
  return (
    <AuthMessageCard
      title="Verification failed"
      body={state.message}
      ctaHref="/sign-in"
      ctaLabel="Go to sign in"
    />
  );
}
