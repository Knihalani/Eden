"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SignedInGate } from "../_components/SignedInGate";
import { DOCS_QUICKSTART_URL, SUPPORT_EMAIL } from "@/lib/constants";

const ctaPrimary =
  "inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

const ctaSecondary =
  "inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)]/80 border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

const fieldClass =
  "mt-1.5 w-full min-h-11 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

const mailtoLinkClass =
  "text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded";

function buildMailtoHref(name: string, email: string, message: string): string {
  const subject = encodeURIComponent(
    name.trim() ? `Eden contact — ${name.trim()}` : "Eden contact",
  );
  const body = encodeURIComponent(
    `From: ${name.trim() || "—"}\nEmail: ${email}\n\n${message}`,
  );
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}

/**
 * Client island — mailto interim.
 * No public contact intake exists; `/support/tickets` requires auth.
 * Must not POST to DSAR (that creates GDPR access tickets).
 *
 * Honest UX: never label the action Send — this only opens the
 * user's email client. A visible mailto fallback is always on-screen
 * for environments where window.location = mailto: is blocked.
 */
export function ContactForm() {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "done">("idle");
  const [feedback, setFeedback] = React.useState<string | null>(null);

  const draftMailto = buildMailtoHref(name, email, message);
  const blankMailto = `mailto:${SUPPORT_EMAIL}`;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    window.location.href = buildMailtoHref(name, email, message);
    setStatus("done");
    setFeedback(
      `Opening your email client to message ${SUPPORT_EMAIL}. If nothing opens, use the link below.`,
    );
  }

  return (
    <>
      <form onSubmit={onSubmit} className="space-y-4 max-w-md" aria-label="Contact Eden" noValidate>
        <p className="text-sm text-[var(--text-muted)]">
          This opens your email client — we do not submit privacy (DSAR) requests from this form.
        </p>
        <label className="block text-sm text-[var(--text-secondary)]">
          Name
          <input
            type="text"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
            autoComplete="name"
            disabled={status === "done"}
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
            disabled={status === "done"}
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
            disabled={status === "done"}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            disabled={status === "done"}
            className="min-h-11"
            aria-label="Open email to contact Eden"
          >
            Open email
          </Button>
          <a
            href={draftMailto}
            className={`text-sm font-medium ${mailtoLinkClass}`}
          >
            Open email client
          </a>
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
              Compose another
            </button>
          )}
        </div>
        {feedback && (
          <p role="status" aria-live="polite" className="text-sm text-[var(--text-secondary)]">
            {feedback}
          </p>
        )}
      </form>
      <p className="mt-6 text-sm text-[var(--text-muted)]">
        Prefer a blank email?{" "}
        <a href={blankMailto} className={mailtoLinkClass}>
          {SUPPORT_EMAIL}
        </a>
      </p>
      <div className="mt-10 flex flex-wrap items-center gap-3">
        <SignedInGate
          signedIn={
            <Link href="/dashboard" className={ctaPrimary}>
              Open dashboard
              <ArrowRight className="w-4 h-4" aria-hidden />
            </Link>
          }
          signedOut={
            <Link href="/sign-up" className={ctaPrimary}>
              Start free
              <ArrowRight className="w-4 h-4" aria-hidden />
            </Link>
          }
        />
        <a
          href={DOCS_QUICKSTART_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={ctaSecondary}
        >
          Quickstart
        </a>
      </div>
    </>
  );
}
