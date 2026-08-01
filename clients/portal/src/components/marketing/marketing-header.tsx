import Link from "next/link";
import { EdenLogo } from "@/components/ds/eden-logo";
import { DOCS_URL } from "@/lib/constants";
import { MarketingAuthCtas } from "@/components/marketing/marketing-auth-ctas";
import { MarketingMobileNav } from "@/components/marketing/marketing-mobile-nav";
import { MarketingRail } from "@/components/marketing/marketing-primitives";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/pricing", label: "Pricing" },
  { href: DOCS_URL, label: "Docs", external: true },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
] as const;

export function MarketingHeader({
  transparent = false,
}: {
  transparent?: boolean;
}) {
  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b border-[var(--line)] backdrop-blur-md",
        transparent
          ? "border-transparent bg-[color-mix(in_srgb,var(--bg)_72%,transparent)]"
          : "bg-[color-mix(in_srgb,var(--bg)_88%,transparent)]",
      )}
    >
      <MarketingRail className="flex h-14 items-center justify-between gap-4">
        <Link
          href="/"
          className="group flex items-center gap-2.5 transition-opacity duration-150 hover:opacity-90"
        >
          <EdenLogo size={22} priority />
          <span className="text-[0.9375rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
            eden
          </span>
        </Link>
        <nav
          className="hidden items-center gap-6 text-[0.875rem] text-[var(--text-muted)] md:flex"
          aria-label="Marketing"
        >
          {NAV.map((item) => {
            const className =
              "transition-colors duration-150 hover:text-[var(--text)]";
            if ("external" in item && item.external) {
              return (
                <a
                  key={item.href}
                  href={item.href}
                  className={className}
                  rel="noopener noreferrer"
                >
                  {item.label}
                </a>
              );
            }
            return (
              <Link key={item.href} href={item.href} className={className}>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          <MarketingAuthCtas size="sm" className="hidden sm:flex" />
          <MarketingMobileNav />
        </div>
      </MarketingRail>
    </header>
  );
}
