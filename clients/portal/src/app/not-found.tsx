import Link from "next/link";
import { EdenLogo } from "@/components/ds/eden-logo";

const SHORTCUTS = [
  { href: "/home", label: "Home", hint: "Fleet pulse" },
  { href: "/traces", label: "Traces", hint: "Live traffic" },
  { href: "/prompts", label: "Prompts", hint: "Registry" },
  { href: "/settings?mode=keys", label: "API keys", hint: "Workspace" },
] as const;

export default function NotFound() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[var(--bg)] px-6 py-20 text-[var(--text)]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.45]"
        style={{
          background:
            "radial-gradient(ellipse 70% 50% at 50% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%)",
        }}
      />
      <div className="relative w-full max-w-md text-center">
        <div className="mb-8 flex justify-center">
          <Link
            href="/home"
            className="rounded-[var(--radius)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            aria-label="Eden home"
          >
            <EdenLogo size={40} />
          </Link>
        </div>
        <p className="type-mono tracking-[0.2em] !text-[var(--text-faint)]">
          404
        </p>
        <h1 className="type-display mt-3 !text-[1.5rem]">Page not found</h1>
        <p className="type-body mx-auto mt-3 max-w-sm text-[var(--text-secondary)]">
          That URL isn’t a product page. Jump back in from one of these, or
          check the sidebar after you land.
        </p>
        <ul className="mt-8 grid grid-cols-1 gap-2 text-left sm:grid-cols-2">
          {SHORTCUTS.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex flex-col rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg-elevated)] px-3.5 py-3 transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-muted)]"
              >
                <span className="type-ui text-[var(--text)]">{item.label}</span>
                <span className="type-meta mt-0.5 text-[var(--text-faint)]">
                  {item.hint}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
