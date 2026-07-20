"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

/** Normalize FastAPI ``detail`` (string | validation array) for UI. */
export function formatProxyDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "msg" in item) {
          return String((item as { msg: unknown }).msg);
        }
        return null;
      })
      .filter((s): s is string => Boolean(s && s.trim()));
    if (parts.length > 0) return parts.join("; ");
  }
  if (detail && typeof detail === "object" && "msg" in detail) {
    const msg = String((detail as { msg: unknown }).msg);
    if (msg.trim()) return msg;
  }
  return fallback;
}

/** Client island — CCPA opt-out POST via portal proxy. */
export function DoNotSellForm() {
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
        const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
        throw new Error(
          formatProxyDetail(body.detail, `Request failed (${res.status})`),
        );
      }
      setStatus("done");
      setMessage("Your Do Not Sell request has been recorded. It takes effect immediately.");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 max-w-md" aria-label="Do Not Sell opt-out">
      <label className="block text-sm text-[var(--text-secondary)]">
        Email address
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1.5 w-full min-h-11 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]"
          autoComplete="email"
          disabled={status === "loading" || status === "done"}
        />
      </label>
      <Button type="submit" loading={status === "loading"} disabled={status === "done"}>
        Submit opt-out
      </Button>
      {message && (
        <p
          role="status"
          aria-live="polite"
          className={
            status === "error"
              ? "text-sm text-[var(--error)]"
              : "text-sm text-[var(--text-secondary)]"
          }
        >
          {message}
        </p>
      )}
    </form>
  );
}
