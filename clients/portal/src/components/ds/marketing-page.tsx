import Link from "next/link";
import { ThinMarketingDoc } from "@/components/marketing/thin-marketing-doc";

/**
 * Shared marketing inner page for one-off titles.
 * Prefer dedicated page modules; this remains for simple wrappers.
 */
export function MarketingPage({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  if (children) {
    return (
      <main>
        <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
            Eden
          </p>
          <h1 className="type-display-lg mt-2">{title}</h1>
          <div className="type-body mt-4 max-w-2xl">{children}</div>
          <p className="mt-8">
            <Link href="/" className="ds-link type-ui">
              ← Home
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <ThinMarketingDoc
      title={title}
      paragraphs={[
        "This page is part of the Eden public site. Reach us if you need more detail.",
      ]}
    />
  );
}
