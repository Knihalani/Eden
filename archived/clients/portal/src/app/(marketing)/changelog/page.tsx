import type { ReactNode } from "react";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { CHANGELOG_ENTRIES } from "@/lib/changelog-entries";
import { DOCS_URL, SUPPORT_EMAIL } from "@/lib/constants";
import { marketingMetadata } from "@/lib/seo";

export const revalidate = 3600;
export const metadata = marketingMetadata({
  path: "/changelog",
  title: "Changelog · Eden — SDK, Portal & Platform Releases",
  description:
    "Product changelog for Eden: SDK releases (0.4.2–0.3.2), portal surfaces, and platform updates. Canonical release notes on edenobservability.com.",
});

const DOCS_CHANGELOG = `${DOCS_URL}/intro/changelog`;

const linkClass =
  "text-[var(--accent)] hover:text-[var(--accent-hover)]";

function SectionKicker({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
      {children}
    </p>
  );
}

export default function ChangelogPage() {
  return (
    <main>
      <MarketingShell
        kicker="Product"
        title="Changelog"
        lead="What shipped in Eden — SDK releases, portal surfaces, and platform changes. This page is the public product changelog for edenobservability.com."
      >
        <div className="max-w-3xl space-y-14">
          <p className="text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
            Looking for engineering detail, Diátaxis notes, or older platform
            milestones? See{" "}
            <a
              href={DOCS_CHANGELOG}
              className={linkClass}
              rel="noopener noreferrer"
            >
              docs · What&apos;s new
            </a>
            . Questions:{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className={`font-mono ${linkClass}`}
            >
              {SUPPORT_EMAIL}
            </a>
            .
          </p>

          <nav aria-label="Releases" className="space-y-3">
            <SectionKicker>Releases</SectionKicker>
            <ul className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[0.75rem] text-[var(--text-muted)]">
              {CHANGELOG_ENTRIES.map((entry) => (
                <li key={entry.id}>
                  <a
                    href={`#${entry.id}`}
                    className="underline-offset-4 hover:text-[var(--text)] hover:underline"
                  >
                    {entry.version}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="space-y-16">
            {CHANGELOG_ENTRIES.map((entry) => (
              <article
                key={entry.id}
                id={entry.id}
                className="scroll-mt-24 space-y-6 border-t border-[var(--line)] pt-10"
              >
                <header className="space-y-3">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <h2 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)] sm:text-[1.5rem]">
                      {entry.version}
                    </h2>
                    <time
                      dateTime={entry.dateIso}
                      className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-[var(--text-faint)]"
                    >
                      {entry.date}
                    </time>
                  </div>
                  <p className="max-w-2xl text-[1rem] leading-relaxed text-[var(--text-secondary)]">
                    {entry.summary}
                  </p>
                </header>

                <div className="space-y-8">
                  {entry.sections.map((section) => (
                    <section key={section.heading} className="space-y-3">
                      <h3 className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
                        {section.heading}
                      </h3>
                      <ul className="space-y-3 border border-[var(--line)] divide-y divide-[var(--line)]">
                        {section.items.map((item) => (
                          <li
                            key={item.slice(0, 72)}
                            className="px-5 py-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]"
                          >
                            {item}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </article>
            ))}
          </div>

          <p className="type-meta text-[var(--text-faint)]">
            Entries summarize shipped product notes from SDK changelogs and the
            docs eng log. They are not a substitute for package{" "}
            <code className="font-mono text-[0.8125rem]">CHANGELOG.md</code>{" "}
            files when upgrading.{" "}
            <Link href="/" className={linkClass}>
              ← Home
            </Link>
          </p>
        </div>
      </MarketingShell>
    </main>
  );
}
