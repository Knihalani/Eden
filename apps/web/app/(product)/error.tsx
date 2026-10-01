"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Product-area boundary: keeps the rail and app bar alive when a page inside
 * the shell fails, so a broken canvas never takes the navigation with it.
 */
export default function ProductError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="home">
      <header className="home-head">
        <h1>This view broke.</h1>
        <p className="home-head-lede">This view failed to render. Nothing was approved, nothing went live.</p>
      </header>
      <div className="home-desk" role="alert">
        <button type="button" className="copy-btn" onClick={reset}>
          Try again
        </button>
        <p className="account-switch">
          Or go back to <Link href="/home">Home</Link>.
        </p>
        {error.digest ? <p className="crash-digest">{error.digest}</p> : null}
      </div>
    </div>
  );
}
