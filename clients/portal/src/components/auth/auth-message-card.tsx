import Link from "next/link";
import { AuthFormCard } from "@/components/auth/auth-form-card";
import { AuthSplitLayout } from "@/components/auth/auth-split-layout";

export function AuthMessageCard({
  title,
  body,
  ctaHref = "/sign-in",
  ctaLabel = "Back to sign in",
}: {
  title: string;
  body: string;
  ctaHref?: string;
  ctaLabel?: string;
}) {
  return (
    <AuthSplitLayout>
      <AuthFormCard>
        <div className="text-center">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-faint)]">
            Account
          </p>
          <h1 className="mt-3 text-[1.0625rem] font-semibold tracking-[-0.02em] text-[var(--text)]">
            {title}
          </h1>
          <p className="mt-3 text-[0.8125rem] leading-relaxed text-[var(--text-muted)]">
            {body}
          </p>
          <Link
            href={ctaHref}
            className="ds-btn ds-btn-primary mt-8 inline-flex px-5"
          >
            {ctaLabel}
          </Link>
        </div>
      </AuthFormCard>
    </AuthSplitLayout>
  );
}
