import { LandingClose, LandingFooter } from "../landing/close";
import { LandingConvert } from "../landing/convert";
import { LandingHero } from "../landing/hero";

export const dynamic = "force-static";
export const revalidate = 3600;

export default function HomePage() {
  return (
    <>
      <main id="content">
        <LandingHero />
        <LandingClose />
      </main>
      <LandingConvert />
      <LandingFooter />
    </>
  );
}
