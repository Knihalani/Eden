"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import { PageHeader } from "@/components/ds/primitives";

/**
 * Soft-land for removed / stub product URLs.
 * Middleware rewrites stubs here while keeping the requested path in the
 * address bar — so usePathname() is the dead URL the user asked for.
 */
const STUB_TRY_INSTEAD: Record<string, { href: string; label: string }> = {
  "/artifacts": { href: "/improve?mode=queue", label: "Improve · Queue" },
  "/billing": { href: "/settings?mode=workspace", label: "Settings" },
  "/finops": { href: "/cost?mode=spend", label: "Cost" },
  "/observability": { href: "/traces", label: "Traces" },
  "/debugger-sessions": { href: "/debugger", label: "Debugger" },
  "/audit": { href: "/settings?mode=audit", label: "Settings · Audit" },
  "/audit-trail": { href: "/settings?mode=audit", label: "Settings · Audit" },
  "/analytics": { href: "/gateway", label: "Gateway" },
  "/labeling": { href: "/evals?mode=datasets", label: "Evals · Datasets" },
  "/studio": { href: "/evals?mode=playground", label: "Evals · Playground" },
  "/synthetic": { href: "/evals?mode=compare", label: "Evals · Results" },
  "/datasets": { href: "/evals?mode=datasets", label: "Evals · Datasets" },
  "/playgrounds": { href: "/evals?mode=playground", label: "Evals · Playground" },
  "/experiments": { href: "/evals?mode=compare", label: "Evals · Results" },
  "/ledger": { href: "/improve?mode=queue", label: "Improve · Queue" },
  "/promotions": { href: "/improve?mode=queue", label: "Improve · Queue" },
  "/optimization": { href: "/cost?mode=spend", label: "Cost" },
  "/runs": { href: "/traces", label: "Traces" },
  "/fleet": { href: "/agents", label: "Agents" },
  "/incidents": { href: "/issues", label: "Issues" },
  "/profile": { href: "/settings", label: "Settings" },
};

const DEFAULT_LINKS = [
  { href: "/home", label: "Home" },
  { href: "/traces", label: "Traces" },
  { href: "/settings?mode=keys", label: "API keys" },
  { href: "/improve", label: "Improve" },
] as const;

function stubPrefix(pathname: string): string | null {
  const p = pathname.split("?")[0].split("#")[0];
  if (p === "/unavailable" || p.startsWith("/unavailable/")) return null;
  const keys = Object.keys(STUB_TRY_INSTEAD).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (p === key || p.startsWith(`${key}/`)) return key;
  }
  return null;
}

function UnavailableInner() {
  const pathname = usePathname() || "/unavailable";
  const searchParams = useSearchParams();
  const fromParam = searchParams.get("from") || searchParams.get("path");

  const requestedPath = useMemo(() => {
    if (fromParam && fromParam.startsWith("/")) return fromParam;
    if (pathname !== "/unavailable" && !pathname.startsWith("/unavailable/")) {
      const q = searchParams.toString();
      return q ? `${pathname}?${q}` : pathname;
    }
    return null;
  }, [fromParam, pathname, searchParams]);

  const mapped = useMemo(() => {
    const pathOnly = (requestedPath ?? pathname).split("?")[0];
    const prefix = stubPrefix(pathOnly);
    return prefix ? STUB_TRY_INSTEAD[prefix] : null;
  }, [requestedPath, pathname]);

  const links = useMemo(() => {
    const out: { href: string; label: string }[] = [];
    if (mapped) out.push(mapped);
    for (const link of DEFAULT_LINKS) {
      if (out.some((x) => x.href === link.href)) continue;
      out.push({ ...link });
    }
    return out;
  }, [mapped]);

  return (
    <div className="ds-page overflow-y-auto">
      <PageHeader title="Page moved" />
      <div className="mx-auto flex max-w-md flex-col gap-4 px-5 py-10">
        <p className="type-body text-[var(--text-secondary)]">
          That URL isn’t in the product anymore. Pick a live surface instead.
        </p>
        {requestedPath ? (
          <p className="type-meta" role="status">
            Requested:{" "}
            <code className="text-[var(--text)]">{requestedPath}</code>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {links.map((link, i) => (
            <Link
              key={link.href}
              href={link.href}
              className={
                i === 0
                  ? "ds-btn ds-btn-primary ds-btn-sm"
                  : "ds-btn ds-btn-sm"
              }
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function UnavailablePage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page overflow-y-auto">
          <PageHeader title="Page moved" />
        </div>
      }
    >
      <UnavailableInner />
    </Suspense>
  );
}
