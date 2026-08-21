import Link from "next/link";
import { BrandMark } from "../brand-mark";
import { MarketingCta, MarketingLinks } from "./links";
import { LandingStage } from "./field";
import { LandingPin } from "./pin";
import { LandingStory } from "./story";

export function LandingHero() {
  return (
    <LandingPin>
      <section className="hero">
        <div className="room" aria-hidden="true">
          <span className="room-sky" />
          <span className="room-desk" />
          <span className="room-blot" />
          <span className="room-grain" />
        </div>
        <div className="well" aria-hidden="true" />
        <header className="hero-header">
          <Link href="/" className="brand" aria-label="Eden">
            <BrandMark priority />
            <span className="brand-name">Eden</span>
          </Link>
          <nav className="hero-nav" aria-label="Account">
            <MarketingLinks area="header" />
          </nav>
        </header>

        <div className="hero-stage">
          <div className="promise">
            <h1 id="promise">Making your agents more deterministic.</h1>
            <MarketingCta />
          </div>
        </div>
        <LandingStory />
      </section>
      <LandingStage />
    </LandingPin>
  );
}
