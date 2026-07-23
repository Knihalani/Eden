import Link from "next/link";
import { PageHeader } from "@/components/ds/primitives";

export const metadata = {
  title: "Unavailable · Eden",
  robots: { index: false, follow: false },
};

export default function UnavailablePage() {
  return (
    <div className="ds-page overflow-y-auto">
      <PageHeader title="Page moved" />
      <div className="mx-auto flex max-w-md flex-col gap-4 px-5 py-10">
        <p className="type-body text-[var(--text-secondary)]">
          That URL isn’t in the product anymore. Pick a live surface instead.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href="/home" className="ds-btn ds-btn-primary ds-btn-sm">
            Home
          </Link>
          <Link href="/traces" className="ds-btn ds-btn-sm">
            Traces
          </Link>
          <Link href="/settings?mode=keys" className="ds-btn ds-btn-sm">
            API keys
          </Link>
        </div>
      </div>
    </div>
  );
}
