"use client";

import * as React from "react";
import { LegalPage } from "@/components/layout/legal-page";
import { Button } from "@/components/ui/button";

export default function ContactPage() {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "loading" | "done" | "error">("idle");
  const [feedback, setFeedback] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setFeedback(null);
    try {
      // Reuse DSAR intake as a tracked ticket for soft-launch contact.
      const res = await fetch("/api/proxy/api/v1/dsar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject_name: name || "Contact",
          subject_email: email,
          request_type: "access",
          details: `[contact] ${message}`,
        }),
      });
      if (!res.ok) {
        throw new Error(`Request failed (${res.status})`);
      }
      const body = await res.json();
      setStatus("done");
      setFeedback(`Thanks — we received your message (ticket ${body.ticket_id}).`);
    } catch (err) {
      setStatus("error");
      setFeedback(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <LegalPage
      eyebrow="Contact"
      title="Get in touch"
      description="Questions about soft launch, volume needs, or security review — send a note and we will respond within a few business days."
      size="narrow"
    >
      <form onSubmit={onSubmit} className="space-y-4 max-w-md">
        <label className="block text-sm text-[var(--text-secondary)]">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)]"
          />
        </label>
        <label className="block text-sm text-[var(--text-secondary)]">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)]"
            autoComplete="email"
          />
        </label>
        <label className="block text-sm text-[var(--text-secondary)]">
          Message
          <textarea
            required
            rows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)]"
          />
        </label>
        <Button type="submit" loading={status === "loading"} disabled={status === "done"}>
          Send
        </Button>
        {feedback && (
          <p
            role="status"
            className={
              status === "error"
                ? "text-sm text-[var(--danger)]"
                : "text-sm text-[var(--text-secondary)]"
            }
          >
            {feedback}
          </p>
        )}
      </form>
      <p className="mt-8 text-sm text-[var(--text-muted)]">
        Or email{" "}
        <a href="mailto:hello@edenobservability.com" className="text-[var(--accent)] hover:underline">
          hello@edenobservability.com
        </a>
        .
      </p>
    </LegalPage>
  );
}
