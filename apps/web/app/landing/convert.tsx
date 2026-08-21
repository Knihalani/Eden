"use client";

import Link from "next/link";
import { useLayoutEffect, useRef } from "react";
import { BrandMark } from "../brand-mark";
import { MarketingLinks } from "./links";

export function LandingConvert() {
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    bar.setAttribute("aria-hidden", "false");
    bar.inert = false;
    document.documentElement.classList.add("is-converting");
  }, []);

  return (
    <nav ref={ref} className="convert" id="convert" aria-hidden="true" inert aria-label="Sign up">
      <Link href="/" className="brand" aria-label="Eden">
        <BrandMark />
        <span className="brand-name">Eden</span>
      </Link>
      <div className="convert-actions">
        <MarketingLinks area="convert" />
      </div>
    </nav>
  );
}
