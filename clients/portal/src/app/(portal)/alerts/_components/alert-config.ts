import {
  AlertTriangle,
  AlertCircle,
  Info,
  ShieldAlert,
  Zap,
} from "lucide-react";

export const ALERT_TABS = ["feed", "signals"] as const;

export const BASE_CHANNEL_CONFIGURED: Record<string, boolean> = {
  in_app: true,
  websocket: true,
  webhook: Boolean(process.env.NEXT_PUBLIC_ALERT_WEBHOOK_CONFIGURED),
  email: false,
  slack: false,
  pagerduty: false,
};

export interface AlertItem {
  alert_id: string;
  title: string;
  description?: string;
  source?: string;
  message: string;
  severity: string;
  entity_id: string;
  acknowledged: boolean;
  triggered_at?: string;
  created_at: string;
  acknowledged_at?: string | null;
  acknowledged_by?: string | null;
  channels: string[];
  metadata?: Record<string, unknown>;
}

export type SeverityFilter =
  | "all"
  | "critical"
  | "high"
  | "warning"
  | "info"
  | "debug";
export type VerdictFilter =
  | "all"
  | "real_incident"
  | "benign"
  | "duplicate"
  | "pending";

export const VERDICT_CONFIG: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  real_incident: {
    label: "Real",
    color: "text-[var(--error)]",
    bg: "bg-[var(--error)]/10",
  },
  benign: {
    label: "Benign",
    color: "text-[var(--text-muted)]",
    bg: "bg-[var(--bg-tertiary)]",
  },
  duplicate: {
    label: "Duplicate",
    color: "text-[var(--accent)]",
    bg: "bg-[var(--accent-faint)]",
  },
  pending: {
    label: "Pending",
    color: "text-[var(--warning)]",
    bg: "bg-[var(--warning-bg)]",
  },
};

export const SEVERITY_CONFIG: Record<
  string,
  { icon: typeof AlertCircle; color: string; bg: string; label: string }
> = {
  critical: {
    icon: ShieldAlert,
    color: "text-[var(--error)]",
    bg: "bg-[var(--error)]/10",
    label: "Critical",
  },
  high: {
    icon: AlertTriangle,
    color: "text-[var(--warning)]",
    bg: "bg-[var(--warning)]/10",
    label: "High",
  },
  warning: {
    icon: AlertCircle,
    color: "text-[var(--warning)]",
    bg: "bg-[var(--warning-bg)]",
    label: "Warning",
  },
  info: {
    icon: Info,
    color: "text-[var(--accent)]",
    bg: "bg-[var(--accent-faint)]",
    label: "Info",
  },
  debug: {
    icon: Zap,
    color: "text-[var(--text-muted)]",
    bg: "bg-[var(--bg-tertiary)]",
    label: "Debug",
  },
};

export function getSeverityConfig(severity: string) {
  return SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.info;
}
