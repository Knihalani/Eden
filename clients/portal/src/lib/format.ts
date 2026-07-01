/**
 * Shared formatting helpers. Centralized so the dashboard, settings,
 * jobs list, multi-agent, alerts, and other pages all use the same
 * relative-time, byte, and duration strings.
 */

export function formatRelativeTime(dateString: string | Date): string {
  const date = typeof dateString === "string" ? new Date(dateString) : dateString;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  if (Number.isNaN(diffMs)) return "—";
  if (diffMs < 0) return "just now";

  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 60) return "just now";

  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1,
  );
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Locale-aware integer formatter (thousand separators).
 * `formatNumber` above is compact (1.2k) for dashboards;
 * this is the spelled-out form for prose and detail pages.
 */
const _intFmt = new Intl.NumberFormat("en-US");
export function formatInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return _intFmt.format(n);
}

/**
 * Currency formatter. Defaults to USD; pass a 3-letter ISO code
 * for the locale's symbol + grouping. Uses Intl.NumberFormat so
 * negatives show in accounting style, decimals are clamped to 2.
 */
export function formatCurrency(
  amount: number | null | undefined,
  currency: string = "USD",
): string {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatChartDate(dateString: string | Date): string {
  const date = typeof dateString === "string" ? new Date(dateString) : dateString;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
