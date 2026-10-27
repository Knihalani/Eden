import Link from "next/link";
import { MarketingCta } from "./links";

export function LandingClose() {
  return (
    <section className="close" aria-labelledby="close-title">
      <h2 id="close-title">Start here.</h2>
      <p>Keep, Know, and whatever comes next.</p>
      <MarketingCta />
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className="site-foot">
      <p>Eden</p>
      <nav aria-label="Footer">
        <a href="#keep">Keep</a>
        <a href="#know">Know</a>
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
