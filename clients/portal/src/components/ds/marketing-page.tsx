import Link from "next/link";

/** Shared marketing inner page (legal, about, pricing stubs). */
export function MarketingPage({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <main>
      <p className="type-label">Eden</p>
      <h1 className="type-display-lg mt-2">{title}</h1>
      <div className="type-body mt-4 max-w-2xl">
        {children ?? (
          <p>Content placeholder during portal greenfield rebuild.</p>
        )}
      </div>
      <p className="mt-8">
        <Link href="/" className="ds-link type-ui">
          ← Home
        </Link>
      </p>
    </main>
  );
}
