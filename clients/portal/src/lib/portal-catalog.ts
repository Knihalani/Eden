/**
 * Client-side catalog bridge: portal GETs sync here so existing
 * fixture helpers (`agentById`, `issueForTrace`, …) resolve live rows
 * without threading arrays through every leaf component.
 *
 * React Query remains source of truth; this is a read-through index.
 */
import type { AgentFixture } from "@/lab/fixtures/agents";
import type { TraceFixture } from "@/lab/fixtures/traces";
import type { IssueFixture } from "@/lab/fixtures/issues";
import type { SignalFixture } from "@/lab/fixtures/signals";
import type { SessionFixture } from "@/lab/fixtures/sessions";
import type { AlertEvent, AlertRule } from "@/lab/fixtures/alerts";
import type { CostDriverFixture } from "@/lab/fixtures/cost";
import type { ImprovePlanFixture } from "@/lab/fixtures/improve";
import type { AbExperimentFixture } from "@/lab/fixtures/compare";
import type { GuardrailPolicyFixture } from "@/lab/fixtures/guardrails";
import type {
  DatasetFixture,
  ExperimentFixture,
  PlaygroundFixture,
} from "@/lab/fixtures/evals";
import type { DebuggerSessionFixture } from "@/lab/fixtures/debugger";
import type { PromptFixture } from "@/lab/fixtures/prompts";
import type { AgentThread } from "@/lab/fixtures/agent-chat";
import type {
  ApiKeyFixture,
  AuditEventFixture,
  AuditPackFixture,
  MemberFixture,
  WorkspaceFixture,
} from "@/lab/fixtures/settings";

export type PortalCatalog = {
  orgId: string | null;
  agents: AgentFixture[];
  traces: TraceFixture[];
  sessions: SessionFixture[];
  issues: IssueFixture[];
  signals: SignalFixture[];
  alertRules: AlertRule[];
  alertEvents: AlertEvent[];
  costDrivers: CostDriverFixture[];
  improvePlans: ImprovePlanFixture[];
  compareExperiments: AbExperimentFixture[];
  guardrailPolicies: GuardrailPolicyFixture[];
  datasets: DatasetFixture[];
  playgrounds: PlaygroundFixture[];
  experiments: ExperimentFixture[];
  debuggerSessions: DebuggerSessionFixture[];
  prompts: PromptFixture[];
  assistantThreads: AgentThread[];
  workspace: WorkspaceFixture | null;
  keys: ApiKeyFixture[];
  members: MemberFixture[];
  auditEvents: AuditEventFixture[];
  auditPacks: AuditPackFixture[];
};

const empty: PortalCatalog = {
  orgId: null,
  agents: [],
  traces: [],
  sessions: [],
  issues: [],
  signals: [],
  alertRules: [],
  alertEvents: [],
  costDrivers: [],
  improvePlans: [],
  compareExperiments: [],
  guardrailPolicies: [],
  datasets: [],
  playgrounds: [],
  experiments: [],
  debuggerSessions: [],
  prompts: [],
  assistantThreads: [],
  workspace: null,
  keys: [],
  members: [],
  auditEvents: [],
  auditPacks: [],
};

let catalog: PortalCatalog = { ...empty };

export function getPortalCatalog(): PortalCatalog {
  return catalog;
}

export function patchPortalCatalog(partial: Partial<PortalCatalog>): void {
  catalog = { ...catalog, ...partial };
}

export function clearPortalCatalog(): void {
  catalog = { ...empty };
}

export function catalogAgents(): AgentFixture[] {
  return catalog.agents;
}
export function catalogTraces(): TraceFixture[] {
  return catalog.traces;
}
export function catalogIssues(): IssueFixture[] {
  return catalog.issues;
}
export function catalogSignals(): SignalFixture[] {
  return catalog.signals;
}
export function catalogSessions(): SessionFixture[] {
  return catalog.sessions;
}
export function catalogAlertRules(): AlertRule[] {
  return catalog.alertRules;
}
export function catalogAlertEvents(): AlertEvent[] {
  return catalog.alertEvents;
}
export function catalogCostDrivers(): CostDriverFixture[] {
  return catalog.costDrivers;
}
export function catalogImprovePlans(): ImprovePlanFixture[] {
  return catalog.improvePlans;
}
export function catalogCompareExperiments(): AbExperimentFixture[] {
  return catalog.compareExperiments;
}
export function catalogGuardrailPolicies(): GuardrailPolicyFixture[] {
  return catalog.guardrailPolicies;
}
export function catalogDatasets(): DatasetFixture[] {
  return catalog.datasets;
}
export function catalogPlaygrounds(): PlaygroundFixture[] {
  return catalog.playgrounds;
}
export function catalogExperiments(): ExperimentFixture[] {
  return catalog.experiments;
}
export function catalogDebuggerSessions(): DebuggerSessionFixture[] {
  return catalog.debuggerSessions;
}
export function catalogPrompts(): PromptFixture[] {
  return catalog.prompts;
}
export function catalogAssistantThreads(): AgentThread[] {
  return catalog.assistantThreads;
}
