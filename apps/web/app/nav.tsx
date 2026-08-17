import Link from "next/link";
import type { ReactNode } from "react";

export function Nav({
  path,
  connected,
  aside,
}: {
  path: "/" | "/live";
  connected?: boolean;
  aside?: ReactNode;
}) {
  return (
    <header className="shell-header">
      <Link href="/" className="brand" aria-label="Eden home">
        <img src="/logo.webp" alt="" width={26} height={26} />
        eden
      </Link>
      <nav className="nav" aria-label="Primary">
        <Link href="/" aria-current={path === "/" ? "page" : undefined}>
          Home
        </Link>
        <Link href="/live" aria-current={path === "/live" ? "page" : undefined}>
          Live
        </Link>
      </nav>
      {(aside || connected != null) && (
        <div className="trail">
          {aside}
          {connected != null && (
            <span className="shell-status">
              <i className={`dot${connected ? " on" : ""}`} aria-hidden />
              {connected ? "agent up" : "waiting"}
            </span>
          )}
        </div>
      )}
    </header>
  );
}
