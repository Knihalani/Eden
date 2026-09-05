import { LandingClose, LandingFooter } from "../landing/close";
import { LandingHero } from "../landing/hero";
import { LandingProducts } from "../landing/products";

export const dynamic = "force-static";
export const revalidate = 3600;

export default function HomePage() {
  return (
    <>
      <main id="content">
        <LandingHero />
        <LandingProducts />
        <LandingClose />
      </main>
      <LandingFooter />
    </>
  );
}
