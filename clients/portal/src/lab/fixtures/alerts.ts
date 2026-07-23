import { ISSUE_LIST, type IssueFixture } from "@/lab/fixtures/issues";
import { TRACE_LIST, type TraceFixture } from "@/lab/fixtures/traces";
import { agentById, type AgentFixture } from "@/lab/fixtures/agents";
import {
  catalogAlertEvents,
  catalogAlertRules,
  catalogIssues,
  catalogTraces,
} from "@/lib/portal-catalog";

export type AlertSeverity = "critical" | "error" | "warn";
export type AlertChannel = "slack" | "email" | "webhook";
export type AlertEventStatus = "firing" | "muted" | "resolved";

export type AlertRule = {
  id: string;
  name: string;
  description: string;
  /** Detector / threshold expression */
  condition: string;
  severity: AlertSeverity;
  /** null = fleet-wide */
  agentId: string | null;
  channel: AlertChannel;
  destination: string;
  enabled: boolean;
  /** Fires in last 24h (mock) */
  fireCount24h: number;
  /** Linked Signals detector when one exists */
  signalId?: string;
};

export type AlertEvent = {
  id: string;
  ruleId: string;
  title: string;
  body: string;
  severity: AlertSeverity;
  status: AlertEventStatus;
  agentId: string;
  firedAt: string;
  relatedIssueId?: string;
  relatedTraceId?: string;
};

/** Empty seed — live rows come from portal catalog / React Query. */
export const ALERT_RULES: AlertRule[] = [];

/** Empty seed — live rows come from portal catalog / React Query. */
export const ALERT_EVENTS: AlertEvent[] = [];

function liveRules(): AlertRule[] {
  const live = catalogAlertRules();
  return live.length > 0 ? live : ALERT_RULES;
}

function liveEvents(): AlertEvent[] {
  const live = catalogAlertEvents();
  return live.length > 0 ? live : ALERT_EVENTS;
}

function liveIssues(): IssueFixture[] {
  const live = catalogIssues();
  return live.length > 0 ? live : ISSUE_LIST;
}

function liveTraces(): TraceFixture[] {
  const live = catalogTraces();
  return live.length > 0 ? live : TRACE_LIST;
}

export function ruleById(id: string): AlertRule | undefined {
  return liveRules().find((r) => r.id === id);
}

export function eventById(id: string): AlertEvent | undefined {
  return liveEvents().find((e) => e.id === id);
}

export function agentForAlert(event: AlertEvent): AgentFixture | undefined {
  return agentById(event.agentId);
}

export function issueForAlert(event: AlertEvent): IssueFixture | undefined {
  if (!event.relatedIssueId) return undefined;
  return liveIssues().find((i) => i.id === event.relatedIssueId);
}

export function traceForAlert(event: AlertEvent): TraceFixture | undefined {
  if (!event.relatedTraceId) return undefined;
  return liveTraces().find((t) => t.id === event.relatedTraceId);
}

export function alertsSnapshot() {
  const events = liveEvents();
  const rules = liveRules();
  const firing = events.filter((e) => e.status === "firing");
  const muted = events.filter((e) => e.status === "muted");
  const resolved = events.filter((e) => e.status === "resolved");
  const rulesOn = rules.filter((r) => r.enabled);
  const rulesOff = rules.filter((r) => !r.enabled);

  return {
    firing,
    muted,
    resolved,
    rulesOn,
    rulesOff,
    firingCount: firing.length,
    ruleCount: rules.length,
    enabledRuleCount: rulesOn.length,
  };
}
