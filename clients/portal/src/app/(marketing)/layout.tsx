import type { Metadata } from "next";
import Link from "next/link";
import { EdenLogo } from "@/components/ds/eden-logo";

const PORTAL = process.env.NEXT_PUBLIC_PORTAL_URL || "https://edenobservability.com";

export const metadata: Metadata = {
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "Eden",
    title: "Eden",
    description: "Observability and improvement for AI agents.",
    url: PORTAL,
  },
  metadataBase: new URL(PORTAL),
};

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-[var(--line)] bg-[var(--bg-sidebar)] px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <EdenLogo size={24} priority />
            <span className="type-title !text-[0.9375rem]">eden</span>
          </Link>
          <nav className="type-ui flex gap-5 text-[var(--text-muted)]">
            <Link
              href="/pricing"
              className="transition-colors hover:text-[var(--text)]"
            >
              Pricing
            </Link>
            <a
              href="https://docs.edenobservability.com"
              className="transition-colors hover:text-[var(--text)]"
            >
              Docs
            </a>
            <Link href="/sign-in" className="ds-link">
              Sign in
            </Link>
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-12">{children}</div>
    </div>
  );
}
