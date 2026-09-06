import Link from "next/link";
import { BrandMark } from "./brand-mark";

export default function NotFound() {
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
          <h1>Nothing here.</h1>
          <p>This page doesn’t exist — it may have moved, or the link is wrong.</p>
        </div>
        <div className="account-door">
          <Link href="/" className="account-enter">
            Go home
          </Link>
          <p className="account-switch">
            Already have an account? <Link href="/sign-in">Sign in</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
