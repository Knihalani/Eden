import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1 className="type-display-lg">Eden</h1>
      <p className="type-body mt-3 max-w-xl !text-[1rem] !text-[var(--text-secondary)]">
        Observability and improvement for AI agents.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/sign-in" className="ds-btn ds-btn-primary px-4">
          Sign in
        </Link>
        <Link href="/sign-up" className="ds-btn ds-btn-outline px-4">
          Sign up
        </Link>
      </div>
    </main>
  );
}
