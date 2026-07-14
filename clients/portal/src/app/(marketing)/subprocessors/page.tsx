"use client";

import * as React from "react";
import { LegalPage } from "@/components/layout/legal-page";

type Subprocessor = { name: string; purpose: string; location: string };

export default function SubprocessorsPage() {
  const [rows, setRows] = React.useState<Subprocessor[] | null>(null);
  const [updated, setUpdated] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/proxy/subprocessors");
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        const body = await res.json();
        if (cancelled) return;
        setRows(body.subprocessors ?? []);
        setUpdated(body.last_updated ?? null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <LegalPage
      eyebrow="Legal"
      title="Subprocessors"
      description="Third parties Eden uses to process customer data (GDPR Art. 28). Customers are notified at least 30 days before material changes."
      size="medium"
      draft
    >
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {!error && !rows && (
        <p className="text-sm text-[var(--text-muted)]">Loading subprocessors…</p>
      )}
      {rows && (
        <>
          {updated && (
            <p className="text-xs font-mono text-[var(--text-muted)] mb-6">
              Last updated: {updated}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)]">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Purpose</th>
                  <th className="py-2 font-medium">Location</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name} className="border-b border-[var(--border-subtle)]">
                    <td className="py-3 pr-4 text-[var(--text-primary)] font-medium">{row.name}</td>
                    <td className="py-3 pr-4 text-[var(--text-secondary)]">{row.purpose}</td>
                    <td className="py-3 text-[var(--text-secondary)]">{row.location}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </LegalPage>
  );
}
