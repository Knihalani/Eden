"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth, useOrganizationList } from "@clerk/nextjs";
import { api, ApiError } from "@/lib/api";

type InviteDetails = {
  valid: boolean;
  org_name: string;
  role: string;
  inviter_name: string;
  expires_at: string;
  email: string;
};

type Phase =
  | "loading"
  | "invalid"
  | "ready"
  | "accepting"
  | "accepted"
  | "error";

function formatExpiry(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

/**
 * Full invite flow: verify token → sign in/up if needed → accept → /home.
 */
export function InviteAcceptPanel({ token }: { token: string }) {
  const router = useRouter();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { isLoaded: orgListLoaded, setActive } = useOrganizationList({
    userMemberships: { infinite: false },
  });
  const [phase, setPhase] = useState<Phase>("loading");
  const [details, setDetails] = useState<InviteDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  const short = token.slice(0, 8);
  const signInHref = `/sign-in?redirect_url=${encodeURIComponent(`/invite/${token}`)}`;
  const signUpHref = `/sign-up?redirect_url=${encodeURIComponent(`/invite/${token}`)}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.verifyInviteToken(token);
        if (cancelled) return;
        if (!data.valid) {
          setPhase("invalid");
          setError("This invitation is no longer valid.");
          return;
        }
        setDetails(data);
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setPhase("invalid");
          setError("Invalid or expired invitation.");
        } else {
          setPhase("error");
          setError(
            err instanceof Error
              ? err.message
              : "Could not verify this invitation.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const onAccept = useCallback(async () => {
    setPhase("accepting");
    setError(null);
    try {
      const result = await api.acceptInviteByToken(token);
      if (result.clerk_org_id && setActive && orgListLoaded) {
        try {
          await setActive({ organization: result.clerk_org_id });
        } catch {
          /* continue — membership exists; portal will sync */
        }
      }
      setPhase("accepted");
      window.setTimeout(() => {
        router.replace("/home");
      }, 600);
    } catch (err) {
      setPhase("ready");
      if (err instanceof ApiError && err.status === 401) {
        setError("Sign in to accept this invitation.");
        return;
      }
      setError(
        err instanceof Error ? err.message : "Could not accept invitation.",
      );
    }
  }, [token, setActive, orgListLoaded, router]);

  if (phase === "loading" || !authLoaded) {
    return (
      <div className="text-center" aria-busy>
        <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
          Invite
        </p>
        <div className="eden-skeleton-pulse mx-auto mt-6 h-5 w-40 rounded bg-[var(--line)]" />
        <div className="eden-skeleton-pulse mx-auto mt-3 h-3.5 w-56 rounded bg-[var(--line)]" />
        <span className="sr-only">Verifying invitation</span>
      </div>
    );
  }

  if (phase === "invalid" || (phase === "error" && !details)) {
    return (
      <div className="text-center">
        <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
          Invite
        </p>
        <h1 className="mt-3 text-[1.0625rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
          Invitation unavailable
        </h1>
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-[var(--text-muted)]">
          {error ?? "This link is invalid or has expired."}
        </p>
        <p className="mt-2 font-mono text-[0.6875rem] text-[var(--text-faint)]">
          {short}…
        </p>
        <Link
          href="/sign-in"
          className="ds-btn ds-btn-primary mt-8 inline-flex px-5"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  if (phase === "accepted") {
    return (
      <div className="text-center">
        <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--success)]">
          Joined
        </p>
        <h1 className="mt-3 text-[1.0625rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
          Welcome to {details?.org_name ?? "the workspace"}
        </h1>
        <p className="mt-3 text-[0.8125rem] text-[var(--text-muted)]">
          Redirecting to home…
        </p>
      </div>
    );
  }

  return (
    <div className="text-center">
      <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
        Invite
      </p>
      <h1 className="mt-3 text-[1.0625rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
        Join {details?.org_name ?? "a workspace"}
      </h1>
      <dl className="mt-5 space-y-2 text-left text-[0.8125rem]">
        <div className="flex justify-between gap-4 border-b border-[var(--line)] py-2">
          <dt className="text-[var(--text-faint)]">Invited by</dt>
          <dd className="text-[var(--text-secondary)]">
            {details?.inviter_name ?? "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-[var(--line)] py-2">
          <dt className="text-[var(--text-faint)]">Role</dt>
          <dd className="font-mono text-[var(--text-secondary)]">
            {details?.role ?? "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-[var(--line)] py-2">
          <dt className="text-[var(--text-faint)]">Email</dt>
          <dd className="truncate text-[var(--text-secondary)]">
            {details?.email ?? "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-4 py-2">
          <dt className="text-[var(--text-faint)]">Expires</dt>
          <dd className="text-[var(--text-secondary)]">
            {details?.expires_at ? formatExpiry(details.expires_at) : "—"}
          </dd>
        </div>
      </dl>

      {error ? (
        <p className="mt-4 text-[0.8125rem] text-[var(--error)]" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-8 flex flex-col gap-2.5">
        {isSignedIn ? (
          <button
            type="button"
            onClick={() => void onAccept()}
            disabled={phase === "accepting"}
            className="ds-btn ds-btn-primary inline-flex w-full justify-center px-5"
          >
            {phase === "accepting" ? "Joining…" : "Accept invitation"}
          </button>
        ) : (
          <>
            <Link
              href={signInHref}
              className="ds-btn ds-btn-primary inline-flex w-full justify-center px-5"
            >
              Sign in to accept
            </Link>
            <Link
              href={signUpHref}
              className="ds-btn ds-btn-outline inline-flex w-full justify-center px-5"
            >
              Create an account
            </Link>
          </>
        )}
      </div>
      <p className="mt-4 font-mono text-[0.625rem] text-[var(--text-faint)]">
        Token {short}…
      </p>
    </div>
  );
}
