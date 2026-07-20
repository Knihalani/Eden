/**
 * Client-side executors for AI Insights navigate / filter / download tools (W21–W22).
 * Server tools return ``client_action`` payloads; the ChatSidebar applies them.
 */

import { downloadCsv, downloadXlsx } from "@/lib/export";
import { isRemovedPortalPath } from "@/lib/portal-routes";

export type ClientToolAction =
  | { client_action: "navigate"; href: string }
  | { client_action: "propose_filter"; q: string; href?: string; path?: string }
  | {
      client_action: "download";
      format: "csv" | "xlsx";
      filename: string;
      rows: Array<Record<string, unknown>>;
    };

const SAFE_PREFIXES = [
  "/traces",
  "/issues",
  "/alerts",
  "/sessions",
  "/debugger-sessions",
  "/artifacts",
  "/experiments",
  "/datasets",
  "/playgrounds",
  "/dashboard",
  "/improve",
  "/agents",
  "/evals",
  "/signals",
  "/promotions",
  "/debugger",
  "/ledger",
  "/fleet",
  "/synthetic",
  "/prompts",
  "/optimization",
  "/observability",
  "/labeling",
  "/settings",
  "/studio",
  "/audit-trail",
  "/analytics",
  "/guardrails",
] as const;

export function isSafePortalHref(href: string): boolean {
  if (!href || typeof href !== "string") return false;
  const h = href.trim();
  if (!h.startsWith("/") || h.startsWith("//")) return false;
  if (h.includes("://") || h.includes("\\")) return false;
  const base = h.split("?")[0]?.split("#")[0] ?? "";
  if (base === "/") return true;
  // Removed surfaces soft-land via next.config; never treat as AI navigate targets.
  if (isRemovedPortalPath(base) || base === "/finops" || base.startsWith("/finops/")) {
    return false;
  }
  return SAFE_PREFIXES.some((p) => base === p || base.startsWith(`${p}/`));
}

function asRowArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is Record<string, unknown> =>
      !!r && typeof r === "object" && !Array.isArray(r),
  );
}

export function extractClientAction(output: unknown): ClientToolAction | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const action = o.client_action;
  if (action === "navigate" && typeof o.href === "string" && isSafePortalHref(o.href)) {
    return { client_action: "navigate", href: o.href };
  }
  if (action === "propose_filter" && typeof o.q === "string" && o.q.trim()) {
    const href =
      typeof o.href === "string" && isSafePortalHref(o.href) ? o.href : undefined;
    const path = typeof o.path === "string" ? o.path : undefined;
    return {
      client_action: "propose_filter",
      q: o.q.trim(),
      ...(href ? { href } : {}),
      ...(path ? { path } : {}),
    };
  }
  if (action === "download") {
    const format = o.format === "xlsx" ? "xlsx" : "csv";
    const filename =
      typeof o.filename === "string" && o.filename.trim()
        ? o.filename.trim()
        : `eden-export.${format}`;
    const rows = asRowArray(o.rows);
    if (rows.length === 0) return null;
    return { client_action: "download", format, filename, rows };
  }
  return null;
}

export type ClientExecutorDeps = {
  navigate: (href: string) => void;
};

/** Apply a client_action from a tool result. Returns true if handled. */
export function executeClientToolAction(
  output: unknown,
  deps: ClientExecutorDeps,
): boolean {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;

  let handled = false;
  const action = extractClientAction(output);
  if (action) {
    if (action.client_action === "navigate") {
      deps.navigate(action.href);
      handled = true;
    } else if (action.client_action === "propose_filter") {
      const href =
        action.href ?? `/traces?q=${encodeURIComponent(action.q)}`;
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("eden:ai-apply-filter", {
            detail: { q: action.q, href, path: action.path },
          }),
        );
      }
      deps.navigate(href);
      handled = true;
    } else if (action.client_action === "download") {
      if (action.format === "xlsx") {
        downloadXlsx(action.filename, action.rows);
      } else {
        downloadCsv(action.filename, action.rows);
      }
      handled = true;
    }
  }

  // Nested download from analysis templates (alongside filter/navigate).
  if (o.download && typeof o.download === "object") {
    if (executeClientToolAction(o.download, deps)) handled = true;
  }

  return handled;
}
