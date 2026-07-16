"use client";

/**
 * Docs Fill-in bridge — same-origin portal page opened as a popup from
 * docs.edenobservability.com so Clerk cookies are available.
 *
 * Query: ``?op=session`` | ``?op=fill``
 * Posts ``{ type: "eden-docs-fill", ... }`` to ``window.opener`` then closes.
 */

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

const DOCS_ORIGINS = new Set([
  "https://docs.edenobservability.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
]);

type BridgePayload = Record<string, unknown> & { type: "eden-docs-fill" };

function postToOpener(payload: BridgePayload) {
  const opener = window.opener as Window | null;
  if (!opener || opener.closed) return false;
  const target = document.referrer
    ? (() => {
        try {
          return new URL(document.referrer).origin;
        } catch {
          return "*";
        }
      })()
    : "*";
  const origin =
    target !== "*" && DOCS_ORIGINS.has(target) ? target : "https://docs.edenobservability.com";
  try {
    opener.postMessage(payload, origin);
    // Also try localhost during local docs preview
    if (origin !== "http://localhost:3000") {
      try {
        opener.postMessage(payload, "http://localhost:3000");
      } catch {
        /* ignore */
      }
    }
    return true;
  } catch {
    return false;
  }
}

export default function DocsFillBridgePage() {
  const { isLoaded, isSignedIn } = useAuth();
  const [status, setStatus] = useState("Connecting to Eden…");

  useEffect(() => {
    if (!isLoaded) return;

    const params = new URLSearchParams(window.location.search);
    const op = params.get("op") === "fill" ? "fill" : "session";

    if (!isSignedIn) {
      setStatus("Sign in required — redirecting…");
      const returnTo = `/docs-fill?op=${op}`;
      window.location.assign(
        `/sign-in?redirect_url=${encodeURIComponent(returnTo)}`,
      );
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        if (op === "session") {
          setStatus("Reading your workspace…");
          const res = await fetch("/api/docs", { credentials: "include" });
          const data = (await res.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          if (cancelled) return;
          postToOpener({ type: "eden-docs-fill", op: "session", ...data });
          setStatus("Connected — you can close this window.");
          window.setTimeout(() => window.close(), 400);
          return;
        }

        setStatus("Creating a Quickstart API key…");
        const res = await fetch("/api/docs", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const data = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        if (cancelled) return;
        if (!res.ok) {
          postToOpener({
            type: "eden-docs-fill",
            op: "fill",
            error:
              (typeof data.error === "string" && data.error) ||
              `Request failed (${res.status})`,
          });
          setStatus("Could not create key — return to docs.");
          return;
        }
        postToOpener({ type: "eden-docs-fill", op: "fill", ...data });
        setStatus("Key created — returning to docs…");
        window.setTimeout(() => window.close(), 400);
      } catch {
        if (cancelled) return;
        postToOpener({
          type: "eden-docs-fill",
          op,
          error: "Could not reach the portal API.",
        });
        setStatus("Something went wrong — return to docs and try again.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-secondary)] px-6">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-8 text-center shadow-xl">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--accent)]">
          Eden docs
        </p>
        <h1 className="mt-2 text-lg font-semibold text-[var(--text-primary)]">
          Fill-in bridge
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
          {status}
        </p>
      </div>
    </div>
  );
}
