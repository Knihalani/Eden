import type { Metadata } from "next";

export const metadata: Metadata = {
  // Marketing pages are public — override the root layout's
  // noindex/robots setting so the landing page can rank in
  // search results. Without this, Google would skip the whole
  // site because the parent layout disallows indexing.
  // June 2026 polish.
  robots: { index: true, follow: true },
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {children}
    </div>
  );
}
