"use client";

import Link from "next/link";
import { useEffect } from "react";
import { BrandMark } from "./brand-mark";

/**
 * Last-resort boundary for anything the segment boundaries don't catch.
 *
 * Sits under the root layout, so the shell chrome (fonts, skip link, theme)
 * survives even when everything else fails. Voice follows PRODUCT.md: quiet,
 * exact, honest — including about what did *not* happen.
 */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="account crash" id="content">
      <header className="hero-header">
        <Link href="/" className="brand" aria-label="Eden">
          <BrandMark />
          <span className="brand-name">Eden</span>
        </Link>
      </header>
      <section className="account-stage">
        <div className="account-copy">
          <h1>Something didn’t hold.</h1>
          <p>This view failed to render. Nothing was approved, nothing went live.</p>
        </div>
        <div className="account-door">
          <button type="button" className="account-enter" onClick={reset}>
            Try again
          </button>
          <p className="account-switch">
            Still broken? <Link href="/">Start from the top.</Link>
          </p>
          {error.digest ? <p className="crash-digest">{error.digest}</p> : null}
        </div>
      </section>
    </main>
  );
}
