import Link from "next/link";
import { redirect } from "next/navigation";
import { isEdenInternal } from "@/lib/rebuild-flags";
import { CURRENT_GATE } from "@/lab/nav";
import { LAB_SURFACES, ROADMAP_NOTE } from "@/lab/registry";
import { Panel } from "@/components/ds/primitives";

export const metadata = {
  title: "Rebuild · Eden",
  robots: { index: false, follow: false },
};

export default function RebuildPage() {
  // Internal review board — customers soft-land on /unavailable.
  if (!isEdenInternal()) redirect("/unavailable");
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <p className="type-label">Internal</p>
      <h1 className="type-display mt-2">Review board</h1>
      <p className="type-body mt-2">
        Review G15a: grouped sidebar (Observe / Evaluate / Improve / Assist /
        Workspace), Assistant + Detectors renames, stub URLs soft-land on
        /unavailable.
      </p>
      <p className="type-meta mt-2">{ROADMAP_NOTE}</p>

      <Panel className="mt-8 p-4">
        <h2 className="type-title">Current gate</h2>
        <p className="type-mono mt-1.5 text-[var(--accent)]">{CURRENT_GATE}</p>
        <pre className="type-mono mt-3 overflow-x-auto rounded-[var(--radius)] bg-[var(--bg-inset)] p-3 !text-[0.6875rem] !text-[var(--text-secondary)]">
{`Gate: G15a
Verdict: approve | reject
Notes: ...`}
        </pre>
      </Panel>

      <section className="mt-8">
        <h2 className="type-title">Product</h2>
        <ul className="mt-3 overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)]">
          {LAB_SURFACES.map((s) => {
            const reviewing = s.id === "home" || s.id === "signals" || s.id === "agent";
            return (
              <li key={s.id} className="border-b border-[var(--line)] last:border-b-0">
                <Link
                  href={s.href}
                  className="type-ui flex items-center justify-between px-3.5 py-2.5 transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <span className="text-[var(--text)]">{s.label}</span>
                  <span
                    className={
                      reviewing
                        ? "type-meta text-[var(--accent)]"
                        : s.status === "approved" || s.status === "ready"
                          ? "type-meta text-[var(--terminal)]"
                          : "type-meta"
                    }
                  >
                    {reviewing ? "review" : s.status}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
