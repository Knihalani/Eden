import Link from "next/link";
import { PageHeader } from "@/components/ds/primitives";

/**
 * Legacy /alerts URL — soft land on Inbox guidance.
 *
 * Firing alerts live in the shell alerts modal (bell). Detectors
 * (/signals) is the rules leaf; do not dump bookmarks there.
 */
export default function AlertsSoftLandPage() {
  return (
    <div className="ds-page overflow-y-auto">
      <PageHeader title="Alert inbox" />
      <div className="mx-auto flex max-w-md flex-col gap-4 px-5 py-10">
        <p className="type-body text-[var(--text-secondary)]">
          Firing alerts open from the bell Inbox in the top bar — there
          is no separate Alerts page anymore.
        </p>
        <p className="type-meta text-[var(--text-secondary)]">
          Threshold and signal rules live under Detectors.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href="/home" className="ds-btn ds-btn-primary ds-btn-sm">
            Back to Home
          </Link>
          <Link href="/signals" className="ds-btn ds-btn-sm">
            Detectors
          </Link>
        </div>
      </div>
    </div>
  );
}
