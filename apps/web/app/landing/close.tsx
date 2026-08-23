import Link from "next/link";
import { MarketingCta } from "./links";

export function LandingClose() {
  return (
    <section className="close" aria-labelledby="close-title">
      <h2 id="close-title">Making your agents more deterministic.</h2>
      <MarketingCta />
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className="site-foot">
      <p>Eden</p>
      <nav aria-label="Footer">
        <Link href="/#story" prefetch={false}>
          How it works
        </Link>
        <Link href="/sign-in" prefetch={false}>
          Sign in
        </Link>
        <Link href="/sign-up" prefetch={false}>
          Sign up
        </Link>
      </nav>
    </footer>
  );
}
