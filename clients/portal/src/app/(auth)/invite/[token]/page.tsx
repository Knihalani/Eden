import Link from "next/link";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="type-display !text-[1.25rem]">Invitation</h1>
      <p className="type-body mt-3">
        Sign in to accept invite{" "}
        <code className="type-mono !text-[var(--text)]">{token.slice(0, 8)}…</code>
      </p>
      <Link
        href={`/sign-in?redirect_url=${encodeURIComponent(`/invite/${token}`)}`}
        className="ds-btn ds-btn-primary mt-6 inline-flex"
      >
        Sign in
      </Link>
    </main>
  );
}
