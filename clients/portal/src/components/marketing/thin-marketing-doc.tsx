import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { SUPPORT_EMAIL } from "@/lib/constants";

/** Thin legal / status pages — honest short copy, not counsel drafts. */
export function ThinMarketingDoc({
  title,
  kicker,
  paragraphs,
}: {
  title: string;
  kicker?: string;
  paragraphs: string[];
}) {
  return (
    <main>
      <MarketingShell kicker={kicker} title={title}>
        <div className="max-w-2xl space-y-4 type-body !text-[1rem] !text-[var(--text-secondary)]">
          {paragraphs.map((p) => (
            <p key={p.slice(0, 48)}>{p}</p>
          ))}
          <p>
            Questions:{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
            >
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
          <p className="pt-4">
            <Link href="/" className="ds-link type-ui">
              ← Home
            </Link>
          </p>
        </div>
      </MarketingShell>
    </main>
  );
}
