"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface FormFieldProps {
  label: string;
  htmlFor?: string;
  description?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * FormField — label + control + optional description/error.
 * Use with Input, Select, Checkbox, Switch, Textarea.
 */
export function FormField({
  label,
  htmlFor,
  description,
  error,
  required,
  className,
  children,
}: FormFieldProps) {
  const descId = htmlFor ? `${htmlFor}-desc` : undefined;
  const errId = htmlFor ? `${htmlFor}-err` : undefined;

  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-[var(--text-primary)]"
      >
        {label}
        {required ? (
          <span className="text-[var(--error)] ml-0.5" aria-hidden>
            *
          </span>
        ) : null}
      </label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id: htmlFor ?? (children.props as { id?: string }).id,
            "aria-invalid": error ? true : undefined,
            "aria-describedby":
              [description ? descId : null, error ? errId : null]
                .filter(Boolean)
                .join(" ") || undefined,
          })
        : children}
      {description && !error ? (
        <p id={descId} className="text-xs text-[var(--text-muted)]">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="text-xs text-[var(--error)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
