import { MarketingRail } from "@/components/marketing/marketing-primitives";

/** Content width + vertical rhythm for non-home marketing pages. */
export function MarketingShell({
  children,
  title,
  kicker,
  lead,
}: {
  children: React.ReactNode;
  title: string;
  kicker?: string;
  lead?: string;
}) {
  return (
    <MarketingRail className="py-14 sm:py-20">
      {kicker ? (
        <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
          {kicker}
        </p>
      ) : null}
      <h1 className="mt-3 max-w-3xl text-[clamp(1.75rem,4vw,2.5rem)] font-semibold leading-[1.1] tracking-[-0.03em] text-[var(--text)]">
        {title}
      </h1>
      {lead ? (
        <p className="mt-4 max-w-2xl text-[1.0625rem] leading-relaxed text-[var(--text-secondary)]">
          {lead}
        </p>
      ) : null}
      <div className="mt-12">{children}</div>
    </MarketingRail>
  );
}
