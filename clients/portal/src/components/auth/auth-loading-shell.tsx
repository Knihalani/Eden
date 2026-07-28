import { EdenLogo } from "@/components/ds/eden-logo";

/** Branded loading shell for Clerk auth routes — skeleton, not bare text. */
export function AuthLoadingShell() {
  return (
    <div className="auth-shell grid min-h-dvh grid-cols-1 bg-[var(--bg)] lg:grid-cols-2">
      <div className="hidden border-r border-[var(--line)] bg-[var(--bg)] lg:block">
        <div className="flex items-center gap-2.5 px-12 pt-12">
          <EdenLogo size={28} />
          <span className="text-[1.0625rem] font-semibold tracking-[-0.02em]">
            eden
          </span>
        </div>
        <div className="mt-14 space-y-3 px-12">
          <div className="eden-skeleton-pulse h-7 w-48 rounded bg-[var(--line)]" />
          <div className="eden-skeleton-pulse h-7 w-40 rounded bg-[var(--line)]" />
          <div className="eden-skeleton-pulse h-7 w-36 rounded bg-[var(--line)]" />
        </div>
      </div>
      <div className="flex flex-col items-center justify-center px-4 py-12">
        <div className="mb-6 flex items-center gap-2.5 lg:hidden">
          <EdenLogo size={28} />
          <span className="text-[1.0625rem] font-semibold tracking-[-0.02em]">
            eden
          </span>
        </div>
        <div className="auth-card flex w-full max-w-[400px] flex-col gap-4">
          <div className="eden-skeleton-pulse mx-auto h-5 w-28 rounded bg-[var(--line)]" />
          <div className="eden-skeleton-pulse mx-auto h-3.5 w-44 rounded bg-[var(--line)]" />
          <div className="mt-2 space-y-3">
            <div className="eden-skeleton-pulse h-10 w-full rounded-lg bg-[var(--line)]" />
            <div className="eden-skeleton-pulse h-10 w-full rounded-lg bg-[var(--line)]" />
            <div className="eden-skeleton-pulse h-10 w-full rounded-lg bg-[var(--accent-muted)]" />
          </div>
          <span className="sr-only">Loading sign-in</span>
        </div>
      </div>
    </div>
  );
}
