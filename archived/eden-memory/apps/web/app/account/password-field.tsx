"use client";

import { useState } from "react";

export function PasswordField({
  id,
  label,
  autoComplete,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  label: string;
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <label className="account-field" htmlFor={id}>
      <span>{label}</span>
      <span className="field-lock">
        <input
          id={id}
          name={autoComplete === "new-password" ? "new-password" : "password"}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          spellCheck={false}
          required
        />
        <button
          type="button"
          className="field-reveal"
          aria-pressed={shown}
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          onClick={() => setShown((on) => !on)}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </span>
    </label>
  );
}
