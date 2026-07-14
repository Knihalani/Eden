"use client";

import * as React from "react";
import Link from "next/link";
import { LegalPage } from "@/components/layout/legal-page";
import { Button } from "@/components/ui/button";

/**
 * CCPA Do Not Sell form — posts to the public FastAPI endpoint via
 * the portal proxy so browsers never hit a raw API GET.
 */
export default function DoNotSellPage() {
  const [email, setEmail] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch("/api/proxy/api/v1/me/do-not-sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed (${res.status})`);
      }
      setStatus("done");
      setMessage("Your Do Not Sell request has been recorded. It takes effect immediately.");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <LegalPage
      eyebrow="CCPA"
      title="Do Not Sell My Personal Information"
      description="California residents can opt out of the sale or sharing of personal information under the CCPA/CPRA. Eden does not sell personal information; submitting this form records your preference."
      size="narrow"
    >
      <form onSubmit={onSubmit} className="space-y-4 max-w-md">
        <label className="block text-sm text-[var(--text-secondary)]">
          Email address
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)]"
            autoComplete="email"
          />
        </label>
        <Button type="submit" loading={status === "loading"} disabled={status === "done"}>
          Submit opt-out
        </Button>
        {message && (
          <p
            role="status"
            className={
              status === "error"
                ? "text-sm text-[var(--danger)]"
                : "text-sm text-[var(--text-secondary)]"
            }
          >
            {message}
          </p>
        )}
      </form>
      <p className="mt-8 text-sm text-[var(--text-muted)]">
        Questions? See our{" "}
        <Link href="/privacy" className="text-[var(--accent)] hover:underline">
          Privacy Policy
        </Link>
        .
      </p>
    </LegalPage>
  );
}
