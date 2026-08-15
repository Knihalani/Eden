"use client";

import { useCallback, useState } from "react";
import { SUPPORT_EMAIL } from "@/lib/constants";

export function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const subject = encodeURIComponent(
        `Eden contact${name.trim() ? ` — ${name.trim()}` : ""}`,
      );
      const body = encodeURIComponent(
        [
          `From: ${name.trim() || "(no name)"}`,
          `Email: ${email.trim() || "(no email)"}`,
          "",
          message.trim(),
        ].join("\n"),
      );
      window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
    },
    [name, email, message],
  );

  return (
    <form
      onSubmit={onSubmit}
      className="flex max-w-lg flex-col gap-5"
      noValidate
    >
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="type-label">Name</span>
          <input
            className="ds-input"
            name="name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="type-label">Email</span>
          <input
            className="ds-input"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="type-label">Message</span>
        <textarea
          className="ds-input min-h-[9rem] resize-y py-2.5"
          name="message"
          required
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" className="ds-btn ds-btn-primary px-5">
          Open email
        </button>
        <p className="type-meta text-[var(--text-faint)]">
          Opens your mail client — nothing is stored on our servers.
        </p>
      </div>
    </form>
  );
}
