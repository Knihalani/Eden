import Link from "next/link";

export function MarketingSignup({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/sign-up" className={compact ? "signup signup-compact" : "signup"} prefetch={false}>
      Sign up
    </Link>
  );
}

export function MarketingLinks({ area }: { area: "header" }) {
  return (
    <div className="auth-links" data-area={area}>
      <Link href="/sign-in" className="signin" prefetch={false}>
        Sign in
      </Link>
      <MarketingSignup compact />
    </div>
  );
}

export function MarketingCta({ solo = false }: { solo?: boolean }) {
  return (
    <div className="promise-cta">
      <MarketingSignup />
      {solo ? null : (
        <Link href="/sign-in" className="signin" prefetch={false}>
          Sign in
        </Link>
      )}
    </div>
  );
}
