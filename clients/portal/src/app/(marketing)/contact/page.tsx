"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { LegalPage } from "@/components/layout/legal-page";
import { Button } from "@/components/ui/button";
import { DOCS_QUICKSTART_URL, SUPPORT_EMAIL } from "@/lib/constants";

const ctaPrimary =
  "inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

const ctaSecondary =
  "inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

const fieldClass =
  "mt-1.5 w-full min-h-11 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

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
      // Soft-launch contact notes reuse the DSAR intake as a tracked ticket.
      // This is not a privacy-rights form — those belong on /privacy.
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
      setFeedback(
        `Thanks — we received your note (reference ${body.ticket_id}). We will reply to ${email}.`,
      );
    } catch {
      setStatus("error");
      setFeedback(
        `Couldn’t reach the server right now. Email ${SUPPORT_EMAIL} and we’ll reply within a few business days.`,
      );
    }
  }

  return (
    <LegalPage
      eyebrow="Contact"
      title="Get in touch"
      description={
        <>
          Soft launch, volume, or security questions — send a note or email{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
          >
            {SUPPORT_EMAIL}
          </a>
          . We reply within a few business days. Privacy rights requests belong on the{" "}
          <Link
            href="/privacy"
            className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
          >
            Privacy
          </Link>{" "}
          page, not this form.
        </>
      }
      size="narrow"
    >
      <form onSubmit={onSubmit} className="space-y-4 max-w-md" aria-label="Contact Eden" noValidate>
        <label className="block text-sm text-[var(--text-secondary)]">
          Name
          <input
            type="text"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
            autoComplete="name"
            disabled={status === "loading" || status === "done"}
          />
        </label>
        <label className="block text-sm text-[var(--text-secondary)]">
          Email
          <input
            type="email"
            name="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldClass}
            autoComplete="email"
            aria-invalid={status === "error" && !email ? true : undefined}
            disabled={status === "loading" || status === "done"}
          />
        </label>
        <label className="block text-sm text-[var(--text-secondary)]">
          Message
          <textarea
            name="message"
            required
            rows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className={`${fieldClass} min-h-[7.5rem]`}
            disabled={status === "loading" || status === "done"}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={status === "loading"}
            disabled={status === "done"}
            className="min-h-11"
          >
            Send
          </Button>
          {status === "done" && (
            <button
              type="button"
              className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
              onClick={() => {
                setStatus("idle");
                setFeedback(null);
                setMessage("");
              }}
            >
              Send another
            </button>
          )}
        </div>
        {feedback && (
          <p
            role="status"
            aria-live="polite"
            className={
              status === "error"
                ? "text-sm text-[var(--error)]"
                : "text-sm text-[var(--text-secondary)]"
            }
          >
            {feedback}
            {status === "error" && (
              <>
                {" "}
                <a
                  href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Eden contact")}&body=${encodeURIComponent(message ? `From: ${name || "—"}\nEmail: ${email}\n\n${message}` : "")}`}
                  className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
                >
                  Open email client
                </a>
                .
              </>
            )}
          </p>
        )}
      </form>
      <p className="mt-8 text-sm text-[var(--text-muted)]">
        Prefer email?{" "}
        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
        >
          {SUPPORT_EMAIL}
        </a>
      </p>
      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Link href="/sign-up" className={ctaPrimary}>
          Start free
          <ArrowRight className="w-4 h-4" aria-hidden />
        </Link>
        <a
          href={DOCS_QUICKSTART_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={ctaSecondary}
        >
          Quickstart
        </a>
      </div>
    </LegalPage>
  );
}
