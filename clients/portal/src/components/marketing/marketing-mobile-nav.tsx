"use client";

import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { DOCS_URL } from "@/lib/constants";
import {
  MARKETING_APP_HREF,
  MARKETING_APP_LABEL,
} from "@/lib/marketing-cta";
import { useMarketingSignedIn } from "@/lib/marketing-signed-in-client";

type NavLink =
  | { href: string; label: string; external?: boolean; primary?: boolean };

function navLinks(signedIn: boolean): NavLink[] {
  const base: NavLink[] = [
    { href: "/why-eden", label: "Why Eden" },
    { href: "/pricing", label: "Pricing" },
    { href: DOCS_URL, label: "Docs", external: true },
    { href: "/about", label: "About" },
    { href: "/contact", label: "Contact" },
  ];
  if (signedIn) {
    return [
      ...base,
      { href: MARKETING_APP_HREF, label: MARKETING_APP_LABEL, primary: true },
    ];
  }
  return [
    ...base,
    { href: "/sign-in", label: "Sign in" },
    { href: "/sign-up", label: "Get started", primary: true },
  ];
}

/** Mobile menu — md+ uses the desktop nav; this is md:hidden only. */
export function MarketingMobileNav() {
  const signedIn = useMarketingSignedIn();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const links = navLinks(signedIn);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        className="ds-btn ds-btn-ghost ds-btn-sm inline-flex items-center gap-2"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
        <span aria-hidden className="flex flex-col gap-1">
          <span
            className={`block h-px w-4 bg-[var(--text)] transition-transform ${open ? "translate-y-[5px] rotate-45" : ""}`}
          />
          <span
            className={`block h-px w-4 bg-[var(--text)] transition-opacity ${open ? "opacity-0" : ""}`}
          />
          <span
            className={`block h-px w-4 bg-[var(--text)] transition-transform ${open ? "-translate-y-[5px] -rotate-45" : ""}`}
          />
        </span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Marketing menu"
        >
          <button
            type="button"
            className="absolute inset-0 bg-[color-mix(in_srgb,var(--bg)_55%,transparent)] backdrop-blur-sm"
            aria-label="Close menu"
            onClick={close}
          />
          <nav
            id={panelId}
            className="absolute inset-x-0 top-0 border-b border-[var(--line)] bg-[var(--bg)] px-5 pb-6 pt-[max(1rem,env(safe-area-inset-top))]"
          >
            <div className="mb-4 flex h-14 items-center justify-between">
              <span className="text-[0.9375rem] font-semibold tracking-[-0.02em]">
                Menu
              </span>
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={close}
              >
                Close
              </button>
            </div>
            <ul className="flex flex-col gap-1">
              {links.map((item) => {
                const className = item.primary
                  ? "ds-btn ds-btn-primary mt-3 w-full justify-center"
                  : "block rounded-md px-3 py-3 text-[0.9375rem] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-muted)] hover:text-[var(--text)]";
                if (item.external) {
                  return (
                    <li key={item.href}>
                      <a
                        href={item.href}
                        className={className}
                        rel="noopener noreferrer"
                        onClick={close}
                      >
                        {item.label}
                      </a>
                    </li>
                  );
                }
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={className}
                      onClick={close}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      ) : null}
    </div>
  );
}
