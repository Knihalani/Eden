import Link from "next/link";
import { BrandMark } from "../brand-mark";
import { LandingLamp } from "./lamp";
import { MarketingCta, MarketingLinks } from "./links";

export function LandingHero() {
  return (
    <section className="land-hero" aria-labelledby="promise">
      <header className="hero-header">
        <Link href="/" className="brand" aria-label="Eden">
          <BrandMark priority />
          <span className="brand-name">Eden</span>
        </Link>
        <nav className="land-products" aria-label="Products">
          <a href="#keep">Keep</a>
          <a href="#know">Know</a>
          <a href="#next">Next</a>
        </nav>
        <nav className="hero-nav" aria-label="Account">
          <MarketingLinks area="header" />
        </nav>
      </header>

      <div className="land-body">
        <div className="land-mast">
          <h1 id="promise">Making your agent do less work.</h1>
          <div className="land-mast-cta">
            <MarketingCta />
          </div>
          <p className="land-lede">Keep is a method you Approve. Know is a named fact with a named source.</p>
        </div>
        <LandingLamp />
      </div>
    </section>
  );
}
