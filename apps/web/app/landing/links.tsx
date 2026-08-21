import Link from "next/link";

export function MarketingLinks({ area }: { area: "header" | "convert" }) {
  return (
    <div className="auth-links" data-area={area}>
      <Link href="/sign-in" className="signin" prefetch={false}>
        Sign in
      </Link>
      <Link href="/sign-up" className="signup signup-compact" prefetch={false}>
        Sign up
      </Link>
    </div>
  );
}

export function MarketingCta() {
  return (
    <div className="promise-cta">
      <Link href="/sign-up" className="signup" prefetch={false}>
        Sign up
      </Link>
      <Link href="/sign-in" className="signin" prefetch={false}>
        Sign in
      </Link>
    </div>
  );
}
