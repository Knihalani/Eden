"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { EvidenceGateResult } from "./evidence-gate";

export type EvidenceGateBannerProps = {
  gate: EvidenceGateResult;
  className?: string;
  actions?: ReactNode;
};

export function EvidenceGateBanner({
  gate,
  className,
  actions,
}: EvidenceGateBannerProps) {
  const tone =
    gate.status === "pass"
      ? "border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
      : gate.status === "override"
        ? "border-[var(--warning)]/40 bg-[var(--warning)]/10"
        : "border-[var(--error)]/40 bg-[var(--error)]/10";

  const label =
    gate.status === "pass"
      ? "EvidenceGate PASS"
      : gate.status === "override"
        ? "EvidenceGate OVERRIDE"
        : "EvidenceGate FAIL";

  return (
    <div
      role="status"
      data-testid="evidence-gate-banner"
      data-gate-status={gate.status}
      className={cn(
        "space-y-2 rounded-md border px-3 py-2 text-sm",
        tone,
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium text-[var(--text-primary)]">{label}</p>
        {actions}
      </div>
      {gate.reasons.length > 0 ? (
        <ul className="list-inside list-disc text-[var(--text-secondary)]">
          {gate.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type EvidenceLink = {
  href: string;
  label: string;
};

export type EvidenceStripProps = {
  links: EvidenceLink[];
  emptyLabel?: string;
  className?: string;
};

export function EvidenceStrip({
  links,
  emptyLabel = "No evidence linked",
  className,
}: EvidenceStripProps) {
  if (links.length === 0) {
    return (
      <p
        className={cn("text-sm text-[var(--text-muted)]", className)}
        data-testid="evidence-strip-empty"
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <nav
      aria-label="Evidence"
      data-testid="evidence-strip"
      className={cn("flex flex-wrap gap-x-3 gap-y-1 text-sm", className)}
    >
      {links.map((l) => (
        <Link
          key={`${l.href}-${l.label}`}
          href={l.href}
          className="text-[var(--accent)] hover:underline"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
