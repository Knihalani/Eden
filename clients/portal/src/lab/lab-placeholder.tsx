import { PageHeader } from "@/components/ds/primitives";

export function LabPlaceholder({
  title,
}: {
  title: string;
  /** @deprecated kept for call-site compat; not shown */
  gate?: string;
}) {
  return (
    <div className="ds-page">
      <PageHeader title={title} />
      <div className="flex flex-1 items-center justify-center bg-[var(--bg)] p-8">
        <p className="type-meta">Coming soon</p>
      </div>
    </div>
  );
}
