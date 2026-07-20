import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/legal-page";

type Subprocessor = { name: string; purpose: string; location: string };

export const metadata: Metadata = {
  title: "Subprocessors · Eden",
  description:
    "Third parties Eden uses to process customer data (GDPR Art. 28). Customers are notified at least 30 days before material changes.",
  openGraph: {
    title: "Subprocessors · Eden",
    description:
      "Third parties Eden uses to process customer data (GDPR Art. 28).",
  },
  twitter: {
    title: "Subprocessors · Eden",
    description:
      "Third parties Eden uses to process customer data (GDPR Art. 28).",
  },
};

/**
 * P19 — server-fetched subprocessors (no client proxy hop).
 */
export default async function SubprocessorsPage() {
  const base = process.env.API_INTERNAL_URL || "http://localhost:8000";
  let rows: Subprocessor[] | null = null;
  let updated: string | null = null;
  let error: string | null = null;

  try {
    const res = await fetch(`${base}/subprocessors`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(`Failed to load (${res.status})`);
    const body = (await res.json()) as {
      subprocessors?: Subprocessor[];
      last_updated?: string;
    };
    rows = body.subprocessors ?? [];
    updated = body.last_updated ?? null;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  return (
    <LegalPage
      eyebrow="Legal"
      title="Subprocessors"
      description="Third parties Eden uses to process customer data (GDPR Art. 28). Customers are notified at least 30 days before material changes."
      size="medium"
      draft
    >
      {error && <p className="text-sm text-[var(--error)]">{error}</p>}
      {!error && rows === null && (
        <p className="text-sm text-[var(--text-muted)]">Unable to load subprocessors.</p>
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
