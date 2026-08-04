"""Portal read-model contracts for later FE wire-up.

Pydantic shapes mirror greenfield lab fixtures under
``clients/portal/src/lab/fixtures/`` (AgentFixture, TraceFixture,
SessionFixture, IssueFixture, SignalFixture, AlertRule/AlertEvent,
CostDriverFixture, WorkspaceFixture, PromptEnv). These are API
response contracts only — they are not wired into the portal FE yet.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# ── Shared literals ───────────────────────────────────────────────

AgentStatus = Literal["live", "idle", "error"]
TraceStatus = Literal["ok", "error"]
TraceSeverity = Literal["error", "warn", "none"]
TranscriptKind = Literal["task", "llm", "tool", "bash", "span"]
SessionOutcome = Literal["ok", "error", "mixed"]
IssueStatus = Literal["open", "acknowledged", "resolved"]
IssueSeverity = Literal["error", "warn"]
SignalSeverity = Literal["critical", "error", "warn"]
SignalKind = Literal["error", "latency", "cost", "policy", "custom"]
NotifyChannel = Literal["email", "webhook"]
AlertSeverity = Literal["critical", "error", "warn"]
AlertChannel = Literal["email", "webhook"]
AlertEventStatus = Literal["firing", "muted", "resolved"]
CostDriverKind = Literal[
    "tool_fanout",
    "model_swap",
    "token_loop",
    "eval_regress",
    "healthy",
]
CostDriverAction = Literal[
    "open_traces",
    "open_improve",
    "open_evals",
    "open_agent",
]
DensityPref = Literal["comfortable", "compact"]
RetentionDays = Literal[7, 30, 90, 365]

PromptPinEnv = Literal["dev", "staging", "prod"]


# ── Agents (AgentFixture) ─────────────────────────────────────────


class AgentCard(BaseModel):
    """Enriched agent card — matches ``AgentFixture`` fields."""

    id: str
    name: str
    purpose: str = ""
    status: AgentStatus = "idle"
    env: str = ""
    model: str = ""
    runs24h: int = 0
    # None = unknown (no scored outcomes / degraded metrics). Never invent.
    successRate: float | None = None
    errorRate: float | None = None
    p50Ms: int = 0
    p95Ms: int = 0
    costUsd24h: float | None = None
    tokens24h: int = 0
    openIssues: int = 0
    lastSeen: str = ""
    topError: str | None = None


# ── Traces (TraceFixture + TranscriptStep) ────────────────────────


class TranscriptStep(BaseModel):
    """One transcript / span step — matches lab ``TranscriptStep``."""

    id: str
    kind: TranscriptKind = "span"
    title: str = ""
    durationMs: int = 0
    status: TraceStatus | None = None
    startedAt: str | None = None
    spanId: str | None = None
    parentId: str | None = None
    model: str | None = None
    provider: str | None = None
    tokensIn: int | None = None
    tokensOut: int | None = None
    costUsd: float | None = None
    attributes: dict[str, str | int | float | bool] | None = None
    inputPreview: str | None = None
    outputPreview: str | None = None
    errorMessage: str | None = None
    metadata: dict[str, str] | None = None


class TraceSignalSummary(BaseModel):
    title: str = ""
    body: str = ""
    count: int | None = None


class TraceListItem(BaseModel):
    """Portal trace list row — matches ``TraceFixture`` fields."""

    id: str
    agentId: str = ""
    name: str = ""
    status: TraceStatus = "ok"
    startedAt: str = ""
    durationMs: int = 0
    tokens: int = 0
    costUsd: float | None = None
    severity: TraceSeverity = "none"
    sessionId: str | None = None
    signals: TraceSignalSummary = Field(default_factory=TraceSignalSummary)
    steps: list[TranscriptStep] = Field(default_factory=list)


# ── Sessions (SessionFixture) ─────────────────────────────────────


class SessionRollup(BaseModel):
    """Multi-turn session rollup — matches ``SessionFixture``."""

    id: str
    agentId: str = ""
    userId: str | None = None
    startedAt: str = ""
    endedAt: str | None = None
    turnCount: int = 0
    outcome: SessionOutcome = "mixed"
    durationMs: int = 0
    totalTokens: int = 0
    costUsd: float | None = None
    lastErrorSummary: str | None = None
    diagnosis: str | None = None
    relatedIssueIds: list[str] = Field(default_factory=list)
    traceIds: list[str] = Field(default_factory=list)


# ── Issues (IssueFixture) ─────────────────────────────────────────


class IssueCard(BaseModel):
    """Grouped failure issue — matches ``IssueFixture``."""

    id: str
    title: str = ""
    summary: str = ""
    body: str = ""
    severity: IssueSeverity = "warn"
    status: IssueStatus = "open"
    agentId: str = ""
    fingerprint: str = ""
    detector: str = ""
    environment: str = ""
    occurrenceTraceIds: list[str] = Field(default_factory=list)
    firstSeen: str = ""
    lastSeen: str = ""
    signalCount: int = 0
    relatedSignalId: str | None = None
    errorSample: str = ""
    impact: str = ""
    suggestedFix: str = ""
    # Soft Autonomy Phase 3: why Eden could not draft a fix PR
    # (e.g. ``repo_not_connected``). Empty when unblocked.
    patchBlockedReason: str = ""
    patchBlockedMessage: str = ""
    tags: list[str] = Field(default_factory=list)


# ── Signals (SignalFixture) ───────────────────────────────────────


class SignalCard(BaseModel):
    """Configured detector — matches ``SignalFixture``."""

    id: str
    name: str = ""
    description: str = ""
    kind: SignalKind = "custom"
    severity: SignalSeverity = "warn"
    condition: str = ""
    agentId: str | None = None
    enabled: bool = True
    notify: bool = False
    channel: NotifyChannel | None = None
    destination: str | None = None
    hits24h: int = 0
    lastHit: str | None = None
    relatedIssueIds: list[str] = Field(default_factory=list)
    exampleTraceIds: list[str] = Field(default_factory=list)
    templateId: str | None = None


# ── Alerts (AlertRule / AlertEvent) ───────────────────────────────


class AlertRuleCard(BaseModel):
    """Alert rule card — matches lab ``AlertRule``."""

    id: str
    name: str = ""
    description: str = ""
    condition: str = ""
    severity: AlertSeverity = "warn"
    agentId: str | None = None
    channel: AlertChannel = "email"
    destination: str = ""
    enabled: bool = True
    fireCount24h: int = 0
    signalId: str | None = None


class AlertEventCard(BaseModel):
    """Fired alert event — matches lab ``AlertEvent``."""

    id: str
    ruleId: str = ""
    title: str = ""
    body: str = ""
    severity: AlertSeverity = "warn"
    status: AlertEventStatus = "firing"
    agentId: str = ""
    firedAt: str = ""
    relatedIssueId: str | None = None
    relatedTraceId: str | None = None


# ── Cost (CostDriverFixture) ──────────────────────────────────────


class CostDriverCard(BaseModel):
    """Cost driver / save opportunity — matches ``CostDriverFixture``."""

    id: str
    title: str = ""
    summary: str = ""
    kind: CostDriverKind = "healthy"
    agentId: str = ""
    estSaveUsd: float = 0.0
    confidence: Literal["high", "med"] = "med"
    traceIds: list[str] = Field(default_factory=list)
    primaryAction: CostDriverAction = "open_traces"
    improvePlanId: str | None = None
    baselineId: str | None = None
    compareId: str | None = None


# ── Workspace prefs + projection ────────────────────────────────────


class WorkspacePrefs(BaseModel):
    """Documented keys merged from ``organizations.settings``.

    Stored / merged keys (snake_case). There is intentionally **no**
    ``region`` field.

    * ``timezone`` — IANA tz name (default ``UTC``)
    * ``density`` — ``comfortable`` | ``compact``
    * ``retention_days`` — ``7`` | ``30`` | ``90`` | ``365``
    * ``pii_redaction`` — bool
    * ``default_notify_channel`` / ``notify_channel`` — email|webhook
      (legacy ``slack`` is coerced to email on read)
    * ``default_notify_destination`` / ``notify_destination`` — address/URL
    """

    timezone: str = "UTC"
    density: DensityPref = "comfortable"
    retention_days: RetentionDays = 30
    pii_redaction: bool = True
    default_notify_channel: NotifyChannel = "email"
    default_notify_destination: str = ""


class WorkspaceCard(BaseModel):
    """Workspace projection for portal settings — matches ``WorkspaceFixture``.

    Assembled from the org row plus ``WorkspacePrefs`` settings merge.
    No ``region`` field.
    """

    id: str
    name: str = ""
    slug: str = ""
    planLabel: str = ""
    isPersonal: bool = False
    timezone: str = "UTC"
    createdAt: str = ""
    density: DensityPref = "comfortable"
    retentionDays: RetentionDays = 30
    piiRedaction: bool = True
    defaultNotifyChannel: NotifyChannel = "email"
    defaultNotifyDestination: str = ""


# ── Prompt pin env (PromptEnv) ────────────────────────────────────
# PromptPinEnv is defined above as Literal["dev","staging","prod"].


# ── Settings: API keys / members / audit ───────────────────────────

KeyStatus = Literal["active", "revoked"]
MemberRole = Literal["owner", "admin", "member", "viewer"]
MemberStatus = Literal["active", "invited", "disabled"]
AuditPackKind = Literal["ledger", "export", "verify"]


class ApiKeyCard(BaseModel):
    """Org API key card — matches lab ``ApiKeyFixture`` (no secret)."""

    id: str
    name: str = ""
    prefix: str = ""
    scopes: list[str] = Field(default_factory=list)
    status: KeyStatus = "active"
    createdAt: str = ""
    lastUsed: str | None = None
    createdBy: str = ""


class MemberCard(BaseModel):
    """Org member / invite card — matches lab ``MemberFixture``."""

    id: str
    name: str = ""
    email: str = ""
    role: MemberRole = "member"
    status: MemberStatus = "active"
    lastActive: str = ""


class AuditEventCard(BaseModel):
    """Audit log row — matches lab ``AuditEventFixture``."""

    id: str
    at: str = ""
    actor: str = ""
    action: str = ""
    target: str = ""
    detail: str | None = None
    href: str | None = None


class AuditPackCard(BaseModel):
    """Compliance / ledger pack — matches lab ``AuditPackFixture``."""

    id: str
    at: str = ""
    agentId: str = ""
    kind: AuditPackKind = "ledger"
    actor: str = ""
    entryHash: str = ""
    verified: bool = False
    rows: int = 0


# ── Evals (Dataset / Playground / Experiment) ─────────────────────

DatasetSource = Literal["traces", "issues", "manual", "import"]
ExperimentStatus = Literal["completed", "running", "failed"]


class DatasetCard(BaseModel):
    """Eval dataset card — matches lab ``DatasetFixture`` (minimal)."""

    id: str
    name: str = ""
    description: str = ""
    agentId: str | None = None
    source: DatasetSource = "manual"
    version: str = "1"
    updatedAt: str = ""
    caseIds: list[str] = Field(default_factory=list)


class PlaygroundCard(BaseModel):
    """Eval playground card — matches lab ``PlaygroundFixture`` (minimal)."""

    id: str
    name: str = ""
    agentId: str | None = None
    datasetId: str | None = None
    prompt: str = ""
    model: str = ""
    dirty: bool = False
    variants: list[dict[str, Any]] = Field(default_factory=list)
    lastRunId: str | None = None


class ExperimentSummary(BaseModel):
    """Offline eval experiment summary — matches lab ``ExperimentFixture``."""

    id: str
    name: str = ""
    datasetId: str = ""
    playgroundId: str | None = None
    status: ExperimentStatus = "completed"
    createdAt: str = ""
    avgScores: dict[str, float] = Field(default_factory=dict)
    latencyMs: float | None = None
    costUsd: float | None = None
    errorRate: float | None = None
    suggestedBaselineId: str | None = None


# ── Improve / Compare / Guardrails / Debugger / Assistant ─────────

ImproveStatus = Literal["needs_you", "in_progress", "verify", "done", "blocked"]
# M13: include code_patch so portal plans retain the real plan_kind.
ImproveKind = Literal["prompt_update", "tool_policy", "config", "code_patch"]
GuardrailStatus = Literal["active", "shadow", "disabled"]
GuardrailAction = Literal["block", "redact", "flag"]
DebuggerModeHint = Literal["replay", "compare", "inspect"]
AssistantPartType = Literal["text", "citations", "actions", "artifacts"]


class ImprovePlanCard(BaseModel):
    """Improve plan card — matches lab ``ImprovePlanFixture``."""

    id: str
    title: str = ""
    status: ImproveStatus = "needs_you"
    kind: str = "config"
    agentId: str | None = None
    issueIds: list[str] = Field(default_factory=list)
    caseIds: list[str] = Field(default_factory=list)
    baselineId: str | None = None
    compareId: str | None = None
    # Soft Autonomy Phase 2: the plan view renders these unconditionally —
    # without them real plans showed a blank Why section and empty diff panes.
    rca: str = ""
    summary: str = ""
    diff: str = ""
    prUrl: str | None = None
    updatedAt: str = ""
    # Soft Autonomy Phase 9: set when the post-PR guardian drafted
    # this plan as a revert/follow-up of an earlier merged plan.
    parentPlanId: str | None = None
    # Evidence tier chips (static / replay / sandbox / …) for Fix now.
    evidenceTier: str | None = None
    hermeticStatus: str | None = None
    failurePackStatus: str | None = None
    evScore: float | None = None


class AbExperimentCard(BaseModel):
    """Production A/B experiment — matches lab ``AbExperimentFixture`` (minimal)."""

    id: str
    name: str = ""
    status: str = "active"
    agentId: str | None = None
    recommendation: str = "need_more_data"
    arms: list[dict[str, Any]] = Field(default_factory=list)
    sampleIds: list[str] = Field(default_factory=list)
    sourceEvalBaselineId: str | None = None
    sourceEvalCompareId: str | None = None
    sourceDebuggerSessionId: str | None = None
    createdAt: str = ""


class GuardrailPolicyCard(BaseModel):
    """Guardrail policy card — matches lab ``GuardrailPolicyFixture``."""

    id: str
    name: str = ""
    kind: str = "custom"
    status: GuardrailStatus = "active"
    agentId: str | None = None
    severity: str = "medium"
    matchCount24h: int = 0
    action: GuardrailAction = "flag"


class DebuggerSessionCard(BaseModel):
    """Debugger session card — matches lab ``DebuggerSessionFixture``."""

    id: str
    title: str = ""
    agentId: str = ""
    sourceTraceId: str | None = None
    compareTraceId: str | None = None
    modeHint: DebuggerModeHint = "inspect"
    notes: str = ""
    updatedAt: str = ""
    lastReplay: dict[str, Any] | None = None


class AssistantMessagePart(BaseModel):
    """One assistant message part — type + flexible payload.

    Lab parts are discriminated unions (``text`` / ``citations`` /
    ``actions`` / ``artifacts``). The API keeps a single shape with
    ``payload`` holding the part-specific fields.
    """

    type: AssistantPartType
    payload: dict[str, Any] = Field(default_factory=dict)


class AssistantThreadCard(BaseModel):
    """Ask-AI / assistant thread card — matches lab ``AgentThread``."""

    id: str
    title: str = ""
    updatedAt: str = ""
    pins: list[dict[str, Any]] = Field(default_factory=list)
    messageCount: int = 0


__all__ = [
    "AbExperimentCard",
    "AgentCard",
    "AlertEventCard",
    "AlertRuleCard",
    "ApiKeyCard",
    "AssistantMessagePart",
    "AssistantThreadCard",
    "AuditEventCard",
    "AuditPackCard",
    "CostDriverCard",
    "DatasetCard",
    "DebuggerSessionCard",
    "ExperimentSummary",
    "GuardrailPolicyCard",
    "ImprovePlanCard",
    "IssueCard",
    "MemberCard",
    "PlaygroundCard",
    "PromptPinEnv",
    "SessionRollup",
    "SignalCard",
    "TraceListItem",
    "TranscriptStep",
    "WorkspaceCard",
    "WorkspacePrefs",
]
