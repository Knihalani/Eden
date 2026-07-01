"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import {
  Plus,
  Trash2,
  Send,
  MessageSquare,
  Users,
  BrainCircuit,
  MemoryStick,
  FlaskConical,
  ShieldCheck,
  ChevronRight,
  Play,
  RefreshCw,
  CheckCircle,
  XCircle,
  Activity,
  Server,
  Network,
  FileText,
  GitCommit,
  AlertTriangle } from "lucide-react";

type TabKey = "environments" | "communication" | "roles" | "memory" | "planning" | "tests" | "hitl";

interface MultiAgentEnv {
  env_id: string;
  name: string;
  pattern: string;
  agent_count: number;
  max_steps: number;
  created_at: string;
}

interface TestResultItem {
  test_name: string;
  passed: boolean;
  duration_ms: number;
  details?: Record<string, unknown>;
  error?: string | null;
}

interface Framework {
  id: string;
  name: string;
  description: string;
  supports: string[];
  complexity: string;
}

interface MessageItem {
  id: string;
  from_agent: string;
  to_agent: string;
  type: string;
  content: Record<string, unknown>;
  timestamp: number;
}

const TAB_ORDER: TabKey[] = ["environments", "communication", "roles", "memory", "planning", "tests", "hitl"];

function useMultiAgentData(orgId: string | undefined) {
  const [envs, setEnvs] = useState<MultiAgentEnv[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchEnvs = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.listMultiAgentEnvs(orgId);
      setEnvs(res.environments);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load environments");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { fetchEnvs(); }, [fetchEnvs]);

  return { envs, loading, error, refresh: fetchEnvs };
}

export default function MultiAgentPage() {
  const { currentOrg } = useOrg();
  const { ConfirmDialog } = useConfirm();
  const orgId = currentOrg?.id;
  const { envs, loading, error, refresh } = useMultiAgentData(orgId);

  const [activeTab, setActiveTab] = useState<TabKey>("environments");
  const [selectedEnv, setSelectedEnv] = useState<MultiAgentEnv | null>(null);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const idx = TAB_ORDER.indexOf(activeTab);
      const nextIdx = e.key === "ArrowRight"
        ? Math.min(idx + 1, TAB_ORDER.length - 1)
        : Math.max(idx - 1, 0);
      setActiveTab(TAB_ORDER[nextIdx]);
      e.preventDefault();
    }
  }, [activeTab]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 page-enter" onKeyDown={handleKeyDown}>
      <PageHeader
        eyebrow="Build"
        title="Multi-Agent Environments"
        subtitle="Orchestrate, observe, and evaluate multi-agent systems"
        icon={Users}
        actions={
          <Button size="sm" variant="outline" onClick={refresh} loading={loading} aria-label="Refresh environments">
            <RefreshCw className="w-4 h-4 mr-1.5" />
            Refresh
          </Button>
        }
      />

      {/* Environment selector */}
      <div className="flex flex-wrap items-center gap-3" aria-busy={loading}>
        <label htmlFor="multi-agent-env-select" className="sr-only">
          Choose environment
        </label>
        <select
          id="multi-agent-env-select"
          aria-label="Select environment"
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-sm text-[var(--text-primary)]"
          value={selectedEnv?.env_id || ""}
          onChange={(e) => {
            const env = envs.find((ev) => ev.env_id === e.target.value) || null;
            setSelectedEnv(env);
          }}
        >
          <option value="">Select environment…</option>
          {envs.map((env) => (
            <option key={env.env_id} value={env.env_id}>
              {env.name} ({env.pattern})
            </option>
          ))}
        </select>
        {error && (
          <span role="alert" className="text-sm text-[var(--error)]">{error}</span>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-[var(--border-default)]" role="tablist" aria-label="Multi-Agent sections">
        <div className="flex gap-1 overflow-x-auto">
          {([
            { key: "environments", label: "Environments", icon: Server },
            { key: "communication", label: "Communication", icon: Network },
            { key: "roles", label: "Roles", icon: ShieldCheck },
            { key: "memory", label: "Memory", icon: MemoryStick },
            { key: "planning", label: "Planning", icon: BrainCircuit },
            { key: "tests", label: "Tests", icon: FlaskConical },
            { key: "hitl", label: "HITL", icon: Activity },
          ] as const).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              role="tab"
              aria-selected={activeTab === key}
              aria-controls={`tabpanel-${key}`}
              id={`tab-${key}`}
              onClick={() => setActiveTab(key)}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap",
                activeTab === key
                  ? "text-[var(--accent)] border-b-2 border-[var(--accent)] bg-[var(--accent-faint)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              )}
            >
              <Icon className="w-4 h-4" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab panels */}
      <div role="tabpanel" id={`tabpanel-${activeTab}`} aria-labelledby={`tab-${activeTab}`}>
        {activeTab === "environments" && (
          <EnvironmentsTab envs={envs} refresh={refresh} orgId={orgId} loading={loading} />
        )}
        {activeTab === "communication" && (
          <CommunicationTab env={selectedEnv} orgId={orgId} />
        )}
        {activeTab === "roles" && (
          <RolesTab env={selectedEnv} orgId={orgId} />
        )}
        {activeTab === "memory" && (
          <MemoryTab env={selectedEnv} orgId={orgId} />
        )}
        {activeTab === "planning" && (
          <PlanningTab env={selectedEnv} orgId={orgId} />
        )}
        {activeTab === "tests" && (
          <TestsTab env={selectedEnv} orgId={orgId} />
        )}
        {activeTab === "hitl" && (
          <HitlTab env={selectedEnv} orgId={orgId} />
        )}
      </div>
      {ConfirmDialog}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Environments Tab
// ──────────────────────────────────────────────────────────────────────────

function EnvironmentsTab({ envs, refresh, orgId, loading }: { envs: MultiAgentEnv[]; refresh: () => void; orgId: string | undefined; loading: boolean }) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("message_passing");
  const [agentCount, setAgentCount] = useState(3);
  const [maxSteps, setMaxSteps] = useState(50);
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    if (!orgId || !name.trim()) return;
    setBusy(true);
    try {
      await api.createMultiAgentEnv(orgId, {
        name: name.trim(),
        communication_pattern: pattern,
        agent_count: agentCount,
        max_steps: maxSteps });
      setName("");
      setPattern("message_passing");
      setAgentCount(3);
      setMaxSteps(50);
      setCreating(false);
      refresh();
      toast.success("Environment created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (envId: string) => {
    if (!orgId) return;
    const ok = await confirm({
      title: "Delete this environment?",
      description: "This removes the environment and all its history. This cannot be undone.",
      confirmLabel: "Delete",
      variant: "destructive" });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteMultiAgentEnv(orgId, envId);
      refresh();
      toast.success("Environment deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Environments</h2>
        <Button size="sm" onClick={() => setCreating(!creating)} aria-expanded={creating} aria-controls="new-env-form">
          <Plus className="w-4 h-4 mr-1.5" />
          {creating ? "Cancel" : "New Environment"}
        </Button>
      </div>

      {creating && (
        <div id="new-env-form" className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="env-name" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Name</label>
              <input
                id="env-name"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Multi-Agent Env"
                aria-label="Environment name"
              />
            </div>
            <div>
              <label htmlFor="env-pattern" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Pattern</label>
              <select
                id="env-pattern"
                aria-label="Communication pattern"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
              >
                <option value="message_passing">Message Passing</option>
                <option value="shared_state">Shared State</option>
                <option value="blackboard">Blackboard</option>
              </select>
            </div>
            <div>
              <label htmlFor="env-agents" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Agents</label>
              <input
                id="env-agents"
                type="number"
                min={2}
                max={20}
                aria-label="Agent count"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
                value={agentCount}
                onChange={(e) => setAgentCount(Number(e.target.value))}
              />
            </div>
            <div>
              <label htmlFor="env-steps" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Max Steps</label>
              <input
                id="env-steps"
                type="number"
                min={1}
                max={500}
                aria-label="Maximum steps"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
                value={maxSteps}
                onChange={(e) => setMaxSteps(Number(e.target.value))}
              />
            </div>
          </div>
          <Button onClick={handleCreate} loading={busy} disabled={!name.trim()}>
            Create
          </Button>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" aria-busy="true" aria-live="polite">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 rounded-xl bg-[var(--bg-primary)] border border-[var(--border-default)] animate-pulse" aria-hidden="true" />
          ))}
        </div>
      ) : envs.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No multi-agent environments yet"
          description="Run a job with multiple agents to see inter-agent communication, role configs, and memory stores here."
          size="md"
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {envs.map((env) => (
            <div
              key={env.env_id}
              className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl hover:border-[var(--accent)] transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-[var(--text-primary)]">{env.name}</h3>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">{env.env_id}</p>
                </div>
                <button
                  onClick={() => handleDelete(env.env_id)}
                  className="p-1.5 text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error-bg)] rounded-lg transition-colors"
                  aria-label={`Delete environment ${env.name}`}
                >
                  <Trash2 className="w-4 h-4" aria-hidden />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                <div className="px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg text-center">
                  <div className="text-[var(--text-muted)]">Pattern</div>
                  <div className="font-medium text-[var(--text-primary)] capitalize">{env.pattern.replace("_", " ")}</div>
                </div>
                <div className="px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg text-center">
                  <div className="text-[var(--text-muted)]">Agents</div>
                  <div className="font-medium text-[var(--text-primary)]">{env.agent_count}</div>
                </div>
                <div className="px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg text-center">
                  <div className="text-[var(--text-muted)]">Steps</div>
                  <div className="font-medium text-[var(--text-primary)]">{env.max_steps}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Communication Tab
// ──────────────────────────────────────────────────────────────────────────

function CommunicationTab({ env, orgId }: { env: MultiAgentEnv | null; orgId: string | undefined }) {
  const toast = useToast();
  const [fromAgent, setFromAgent] = useState("agent_0");
  const [toAgent, setToAgent] = useState("agent_1");
  const [msgContent, setMsgContent] = useState("{}");
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [broadcastContent, setBroadcastContent] = useState("{}");

  const fetchMessages = async () => {
    if (!orgId || !env) return;
    try {
      const res = await api.getMultiAgentMessages(orgId, env.env_id, toAgent);
      // The API returns message_id/sent_at; the local MessageItem
      // uses id/type/timestamp. Map at the boundary so the rest of
      // the page can stay loosely typed on local semantics.
      setMessages(
        res.messages.map((m) => ({
          id: m.message_id,
          from_agent: m.from_agent,
          to_agent: m.to_agent,
          type: "direct",
          content: m.content,
          timestamp: new Date(m.sent_at).getTime() })),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load messages");
    }
  };

  const fetchStats = async () => {
    if (!orgId || !env) return;
    try {
      const res = await api.getMultiAgentCommStats(orgId, env.env_id);
      setStats(res.stats);
    } catch (err) {
      // Communication stats are non-critical; log only.
      console.warn("comm stats fetch failed", err);
    }
  };

  useEffect(() => { fetchMessages(); fetchStats(); }, [env, orgId, toAgent]);

  const handleSend = async () => {
    if (!orgId || !env) return;
    setSending(true);
    try {
      let content: Record<string, unknown> = {};
      try { content = JSON.parse(msgContent); } catch { content = { text: msgContent }; }
      await api.sendMultiAgentMessage(orgId, env.env_id, { from_agent: fromAgent, to_agent: toAgent, content });
      setMsgContent("{}");
      fetchMessages();
      fetchStats();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  const handleBroadcast = async () => {
    if (!orgId || !env) return;
    setSending(true);
    try {
      let content: Record<string, unknown> = {};
      try { content = JSON.parse(broadcastContent); } catch { content = { text: broadcastContent }; }
      await api.broadcastMultiAgentMessage(orgId, env.env_id, { from_agent: fromAgent, content });
      setBroadcastContent("{}");
      fetchStats();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Broadcast failed");
    } finally {
      setSending(false);
    }
  };

  if (!env) {
    return <EmptyState icon={Network} title="Select an environment" description="Choose an environment from the list to view inter-agent communication." />;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Send Message */}
        <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl space-y-4">
          <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Send className="w-4 h-4 text-[var(--accent)]" aria-hidden />
            Send Message
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="msg-from" className="text-xs text-[var(--text-muted)]">From</label>
              <input
                id="msg-from"
                aria-label="From agent"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
                value={fromAgent}
                onChange={(e) => setFromAgent(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="msg-to" className="text-xs text-[var(--text-muted)]">To</label>
              <input
                id="msg-to"
                aria-label="To agent"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
                value={toAgent}
                onChange={(e) => setToAgent(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label htmlFor="msg-content" className="text-xs text-[var(--text-muted)]">Content (JSON)</label>
            <textarea
              id="msg-content"
              aria-label="Message content as JSON"
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm font-mono"
              rows={3}
              value={msgContent}
              onChange={(e) => setMsgContent(e.target.value)}
            />
          </div>
          <Button size="sm" onClick={handleSend} loading={sending}>
            <Send className="w-4 h-4 mr-1.5" />
            Send
          </Button>
        </div>

        {/* Broadcast */}
        <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl space-y-4">
          <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-[var(--accent)]" aria-hidden />
            Broadcast
          </h3>
          <div>
            <label htmlFor="bc-from" className="text-xs text-[var(--text-muted)]">From</label>
            <input
              id="bc-from"
              aria-label="Broadcast from agent"
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
              value={fromAgent}
              onChange={(e) => setFromAgent(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="bc-content" className="text-xs text-[var(--text-muted)]">Content (JSON)</label>
            <textarea
              id="bc-content"
              aria-label="Broadcast content as JSON"
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm font-mono"
              rows={3}
              value={broadcastContent}
              onChange={(e) => setBroadcastContent(e.target.value)}
            />
          </div>
          <Button size="sm" onClick={handleBroadcast} loading={sending}>
            <MessageSquare className="w-4 h-4 mr-1.5" />
            Broadcast
          </Button>
        </div>
      </div>

      {/* Messages inbox */}
      <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-[var(--text-primary)]">Inbox ({toAgent})</h3>
          <Button size="sm" variant="outline" onClick={fetchMessages} aria-label="Refresh inbox">
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            Refresh
          </Button>
        </div>
        {messages.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No inter-agent messages"
            description="Messages between agents in this environment will appear here as the pipeline runs."
            size="sm"
          />
        ) : (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {messages.map((msg) => (
              <div key={msg.id} className="p-3 bg-[var(--bg-tertiary)] rounded-lg text-sm">
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] mb-1">
                  <span className="font-medium text-[var(--text-primary)]">{msg.from_agent}</span>
                  <ChevronRight className="w-3 h-3" aria-hidden />
                  <span>{msg.to_agent}</span>
                  <span className="ml-auto">{msg.type}</span>
                </div>
                <pre className="text-xs text-[var(--text-secondary)] overflow-x-auto">{JSON.stringify(msg.content, null, 2)}</pre>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stats */}
      {stats && (
        <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
          <h3 className="font-semibold text-[var(--text-primary)] mb-3">Communication Stats</h3>
          <pre className="text-xs text-[var(--text-secondary)] overflow-x-auto">{JSON.stringify(stats, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Roles Tab
// ──────────────────────────────────────────────────────────────────────────

function RolesTab({ env, orgId }: { env: MultiAgentEnv | null; orgId: string | undefined }) {
  const toast = useToast();
  const [roles, setRoles] = useState<Record<string, unknown>[]>([]);
  const [configs, setConfigs] = useState<Record<string, unknown>[]>([]);
  const [creatingConfig, setCreatingConfig] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [selectedRoleName, setSelectedRoleName] = useState("");
  const [busy, setBusy] = useState(false);

  const fetchData = async () => {
    if (!orgId || !env) return;
    try {
      const [rRes, cRes] = await Promise.all([
        api.listAgentRoles(orgId, env.env_id),
        api.listRoleConfigs(orgId, env.env_id),
      ]);
      setRoles(rRes.roles);
      setConfigs(cRes.configs);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load roles");
    }
  };

  useEffect(() => { fetchData(); }, [env, orgId]);

  const handleCreateConfig = async () => {
    if (!orgId || !env || !roleName.trim()) return;
    setBusy(true);
    try {
      await api.createRoleConfig(orgId, env.env_id, {
        role_name: roleName.trim(),
        hierarchy: "flat",
        objectives: [],
        tools: [] });
      setRoleName("");
      setCreatingConfig(false);
      fetchData();
      toast.success("Role config created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const handleAssign = async () => {
    if (!orgId || !env || !agentId.trim() || !selectedRoleName) return;
    setBusy(true);
    try {
      await api.assignAgentRole(orgId, env.env_id, { agent_id: agentId.trim(), role_name: selectedRoleName });
      setAgentId("");
      setAssigning(false);
      fetchData();
      toast.success("Role assigned");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  if (!env) {
    return <EmptyState icon={ShieldCheck} title="Select an environment" description="Choose an environment to manage agent roles and permissions." />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => setCreatingConfig(!creatingConfig)} aria-expanded={creatingConfig} aria-controls="new-role-config">
          <Plus className="w-4 h-4 mr-1.5" />
          {creatingConfig ? "Cancel" : "New Role Config"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAssigning(!assigning)} aria-expanded={assigning} aria-controls="assign-role-form">
          <Users className="w-4 h-4 mr-1.5" />
          {assigning ? "Cancel" : "Assign Role"}
        </Button>
      </div>

      {creatingConfig && (
        <div id="new-role-config" className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl space-y-3">
          <label htmlFor="role-name-input" className="text-xs text-[var(--text-muted)]">Role name</label>
          <input
            id="role-name-input"
            aria-label="Role name"
            className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
            placeholder="Role name (e.g. planner, executor, critic)"
            value={roleName}
            onChange={(e) => setRoleName(e.target.value)}
          />
          <Button size="sm" onClick={handleCreateConfig} loading={busy} disabled={!roleName.trim()}>
            Create Config
          </Button>
        </div>
      )}

      {assigning && (
        <div id="assign-role-form" className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="assign-agent-id" className="text-xs text-[var(--text-muted)]">Agent ID</label>
              <input
                id="assign-agent-id"
                aria-label="Agent ID"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
                placeholder="Agent ID"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="assign-role-select" className="text-xs text-[var(--text-muted)]">Role</label>
              <select
                id="assign-role-select"
                aria-label="Role configuration"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
                value={selectedRoleName}
                onChange={(e) => setSelectedRoleName(e.target.value)}
              >
                <option value="">Select role config…</option>
                {configs.map((c, i) => (
                  <option key={i} value={String(c.role_name || c.name || "")}>
                    {String(c.role_name || c.name || "unnamed")}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Button size="sm" onClick={handleAssign} loading={busy} disabled={!agentId.trim() || !selectedRoleName}>
            Assign
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">Role Configs</h3>
          {configs.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No role configurations"
              description="Define agent roles, hierarchies, and tool access above to manage this environment."
              size="sm"
            />
          ) : (
            <div className="space-y-2">
              {configs.map((c, i) => (
                <div key={i} className="p-3 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-sm">
                  <div className="font-medium text-[var(--text-primary)]">{String(c.role_name || c.name || "unnamed")}</div>
                  <div className="text-xs text-[var(--text-muted)] mt-1">Hierarchy: {String(c.hierarchy || "flat")}</div>
                  <div className="text-xs text-[var(--text-muted)]">Tools: {(c.tools as string[] || []).join(", ") || "none"}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">Assigned Roles</h3>
          {roles.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No roles assigned"
              description="Assign a role to an agent above to give it a place in the hierarchy."
              size="sm"
            />
          ) : (
            <div className="space-y-2">
              {roles.map((r, i) => (
                <div key={i} className="p-3 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[var(--text-primary)]">{String(r.agent_id)}</span>
                    <span className="text-xs px-2 py-0.5 bg-[var(--accent-faint)] text-[var(--accent)] rounded-full">{String(r.role_name || "unknown")}</span>
                  </div>
                  {r.team_id ? <div className="text-xs text-[var(--text-muted)] mt-1">Team: {String(r.team_id)}</div> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Memory Tab
// ──────────────────────────────────────────────────────────────────────────

function MemoryTab({ env, orgId }: { env: MultiAgentEnv | null; orgId: string | undefined }) {
  const toast = useToast();
  const [agentId, setAgentId] = useState("agent_0");
  const [obsContent, setObsContent] = useState("");
  const [memoryData, setMemoryData] = useState<Record<string, unknown> | null>(null);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [adding, setAdding] = useState(false);
  const [consolidating, setConsolidating] = useState(false);

  const fetchMemory = async () => {
    if (!orgId || !env) return;
    try {
      const res = await api.queryMemory(orgId, env.env_id, agentId);
      setMemoryData(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to query memory");
    }
  };

  const fetchStats = async () => {
    if (!orgId || !env) return;
    try {
      const res = await api.getMemoryStats(orgId, env.env_id);
      setStats(res);
    } catch (err) {
      console.warn("memory stats fetch failed", err);
    }
  };

  useEffect(() => { fetchMemory(); fetchStats(); }, [env, orgId, agentId]);

  const handleAddObservation = async () => {
    if (!orgId || !env || !obsContent.trim()) return;
    setAdding(true);
    try {
      await api.addObservation(orgId, env.env_id, { agent_id: agentId, content: obsContent.trim() });
      setObsContent("");
      fetchMemory();
      fetchStats();
      toast.success("Observation added");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setAdding(false);
    }
  };

  const handleConsolidate = async () => {
    if (!orgId || !env) return;
    setConsolidating(true);
    try {
      await api.consolidateMemory(orgId, env.env_id, agentId);
      fetchMemory();
      fetchStats();
      toast.success("Memory consolidated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setConsolidating(false);
    }
  };

  if (!env) {
    return <EmptyState icon={MemoryStick} title="Select an environment" description="Choose an environment to view and manage agent memory stores." />;
  }

  const workingCount = stats?.working_memory_count;
  const episodesTotal = (stats?.episodic as Record<string, unknown>)?.total_recorded;
  const factsTotal = (stats?.semantic as Record<string, unknown>)?.total_facts;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <StatCard
          title="Working Memories"
          value={workingCount == null ? "—" : String(workingCount)}
          icon={MemoryStick}
          empty={workingCount == null}
          emptyText="Stats unavailable"
        />
        <StatCard
          title="Episodes Recorded"
          value={episodesTotal == null ? "—" : String(episodesTotal)}
          icon={GitCommit}
          empty={episodesTotal == null}
          emptyText="Stats unavailable"
        />
        <StatCard
          title="Semantic Facts"
          value={factsTotal == null ? "—" : String(factsTotal)}
          icon={FileText}
          empty={factsTotal == null}
          emptyText="Stats unavailable"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Add observation */}
        <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl space-y-4">
          <h3 className="font-semibold text-[var(--text-primary)]">Add Observation</h3>
          <div>
            <label htmlFor="mem-agent-id" className="text-xs text-[var(--text-muted)]">Agent ID</label>
            <input
              id="mem-agent-id"
              aria-label="Agent ID for memory observation"
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="mem-obs-content" className="text-xs text-[var(--text-muted)]">Content</label>
            <textarea
              id="mem-obs-content"
              aria-label="Observation content"
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
              rows={3}
              value={obsContent}
              onChange={(e) => setObsContent(e.target.value)}
              placeholder="Agent observed..."
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAddObservation} loading={adding} disabled={!obsContent.trim()}>
              <Plus className="w-4 h-4 mr-1.5" />
              Add
            </Button>
            <Button size="sm" variant="outline" onClick={handleConsolidate} loading={consolidating}>
              <RefreshCw className="w-4 h-4 mr-1.5" />
              Consolidate
            </Button>
          </div>
        </div>

        {/* Memory query result */}
        <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
          <h3 className="font-semibold text-[var(--text-primary)] mb-3">Query Result ({agentId})</h3>
          {memoryData ? (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-1">Working Memory Summary</div>
                <div className="p-2 bg-[var(--bg-tertiary)] rounded-lg text-[var(--text-secondary)] text-xs whitespace-pre-wrap">
                  {String(memoryData.working_memory_summary || "Empty")}
                </div>
              </div>
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-1">Episodes ({(memoryData.episodes as unknown[] || []).length})</div>
                <div className="max-h-[120px] overflow-y-auto space-y-1">
                  {(memoryData.episodes as Record<string, unknown>[] || []).map((ep, i) => (
                    <div key={i} className="p-2 bg-[var(--bg-tertiary)] rounded-lg text-xs">
                      <div className="font-medium">{String(ep.episode_id || "—")}</div>
                      <div className="text-[var(--text-muted)]">Reward: {String(ep.total_reward ?? "—")} | Success: {String(ep.success ?? "—")}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-1">Facts ({(memoryData.facts as unknown[] || []).length})</div>
                <div className="max-h-[120px] overflow-y-auto space-y-1">
                  {(memoryData.facts as Record<string, unknown>[] || []).map((f, i) => (
                    <div key={i} className="p-2 bg-[var(--bg-tertiary)] rounded-lg text-xs">
                      {String(f.subject)} → {String(f.relation)} → {String(f.object)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={MemoryStick}
              title="No memory data yet"
              description="Working memory, episodes, and semantic facts from agent runs will appear here as the pipeline completes."
              size="sm"
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Planning Tab
// ──────────────────────────────────────────────────────────────────────────

function PlanningTab({ env, orgId }: { env: MultiAgentEnv | null; orgId: string | undefined }) {
  const toast = useToast();
  const [frameworks, setFrameworks] = useState<Framework[]>([]);
  const [selectedFramework, setSelectedFramework] = useState("react");
  const [agentIds, setAgentIds] = useState("agent_0,agent_1");
  const [maxSteps, setMaxSteps] = useState(20);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!orgId) return;
    api.listPlanningFrameworks(orgId)
      .then((res) => setFrameworks(res.frameworks))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load frameworks"));
  }, [orgId, toast]);

  const handleRun = async () => {
    if (!orgId || !env) return;
    setRunning(true);
    try {
      const ids = agentIds.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await api.runEpisode(orgId, env.env_id, { framework: selectedFramework, agent_ids: ids, max_steps: maxSteps });
      setResult(res.result);
      toast.success("Episode complete");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {frameworks.map((fw) => (
          <button
            key={fw.id}
            onClick={() => setSelectedFramework(fw.id)}
            aria-pressed={selectedFramework === fw.id}
            aria-label={`${fw.name} framework`}
            className={cn(
              "p-4 text-left rounded-xl border transition-all",
              selectedFramework === fw.id
                ? "border-[var(--accent)] bg-[var(--accent-faint)]"
                : "border-[var(--border-default)] bg-[var(--bg-primary)] hover:border-[var(--accent)]"
            )}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-[var(--text-primary)]">{fw.name}</span>
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                fw.complexity === "high" ? "bg-[var(--warning-bg)] text-[var(--warning)]  " :
                fw.complexity === "medium" ? "bg-[var(--accent-faint)] text-[var(--accent)]  " :
                "bg-[var(--terminal-faint)] text-[var(--terminal)]  "
              )}>
                {fw.complexity}
              </span>
            </div>
            <p className="text-xs text-[var(--text-muted)] line-clamp-3">{fw.description}</p>
            <div className="flex flex-wrap gap-1 mt-2">
              {fw.supports.map((s) => (
                <span key={s} className="text-[10px] px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-muted)]">{s}</span>
              ))}
            </div>
          </button>
        ))}
      </div>

      {env && (
        <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl space-y-4">
          <h3 className="font-semibold text-[var(--text-primary)]">Run Episode</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="plan-agent-ids" className="text-xs text-[var(--text-muted)]">Agent IDs (comma-separated)</label>
              <input
                id="plan-agent-ids"
                aria-label="Agent IDs"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
                value={agentIds}
                onChange={(e) => setAgentIds(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="plan-max-steps" className="text-xs text-[var(--text-muted)]">Max Steps</label>
              <input
                id="plan-max-steps"
                aria-label="Maximum steps"
                type="number"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
                value={maxSteps}
                onChange={(e) => setMaxSteps(Number(e.target.value))}
              />
            </div>
            <div className="flex items-end">
              <Button onClick={handleRun} loading={running} className="w-full">
                <Play className="w-4 h-4 mr-1.5" />
                Run Episode
              </Button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
          <h3 className="font-semibold text-[var(--text-primary)] mb-3">Episode Result</h3>
          <pre className="text-xs text-[var(--text-secondary)] overflow-x-auto">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tests Tab
// ──────────────────────────────────────────────────────────────────────────

function TestsTab({ env, orgId }: { env: MultiAgentEnv | null; orgId: string | undefined }) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [testResults, setTestResults] = useState<{
    total_tests: number;
    passed: number;
    failed: number;
    duration_ms: number;
    all_passed: boolean;
    results: TestResultItem[];
  } | null>(null);
  const [benchmarks, setBenchmarks] = useState<Record<string, unknown> | null>(null);

  const handleRunTests = async () => {
    if (!orgId || !env) return;
    setRunning(true);
    try {
      const res = await api.runMultiAgentTests(orgId, env.env_id);
      setTestResults(res);
      toast.success(res.all_passed ? "All tests passed" : `${res.failed} test(s) failed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Tests failed");
    } finally {
      setRunning(false);
    }
  };

  const handleBenchmark = async () => {
    if (!orgId || !env) return;
    setRunning(true);
    try {
      const res = await api.runMultiAgentBenchmark(orgId, env.env_id);
      setBenchmarks(res);
      toast.success("Benchmark complete");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Benchmark failed");
    } finally {
      setRunning(false);
    }
  };

  const fetchResults = async () => {
    if (!orgId || !env) return;
    try {
      const res = await api.getMultiAgentTestResults(orgId, env.env_id);
      setTestResults(res);
    } catch (err) {
      console.warn("test results fetch failed", err);
    }
  };

  useEffect(() => { fetchResults(); }, [env, orgId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button onClick={handleRunTests} loading={running} disabled={!env}>
          <FlaskConical className="w-4 h-4 mr-1.5" />
          Run Test Suite
        </Button>
        <Button variant="outline" onClick={handleBenchmark} loading={running} disabled={!env}>
          <Activity className="w-4 h-4 mr-1.5" />
          Benchmark
        </Button>
      </div>

      {testResults && (
        <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard title="Total" value={String(testResults.total_tests)} icon={FlaskConical} accent="neutral" />
            <StatCard title="Passed" value={String(testResults.passed)} icon={CheckCircle} accent="terminal" />
            <StatCard title="Failed" value={String(testResults.failed)} icon={XCircle} accent="error" />
            <StatCard title="Duration" value={`${Math.round(testResults.duration_ms)}ms`} icon={Activity} accent="accent" />
          </div>

          <div className="space-y-2">
            {testResults.results.map((r, i) => (
              <div key={i} className={cn(
                "flex items-center gap-3 p-3 rounded-lg text-sm border",
                r.passed
                  ? "bg-[var(--terminal-faint)] border-[var(--terminal)]/20  "
                  : "bg-[var(--error-bg)] border-[var(--error-dim)]  "
              )}>
                {r.passed ? (
                  <CheckCircle className="w-5 h-5 text-[var(--terminal)] shrink-0" aria-hidden />
                ) : (
                  <XCircle className="w-5 h-5 text-[var(--error)] shrink-0" aria-hidden />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-[var(--text-primary)] capitalize">{r.test_name.replace("_", " ")}</div>
                  {r.error && <div className="text-xs text-[var(--error)]  mt-0.5">{r.error}</div>}
                </div>
                <span className="text-xs text-[var(--text-muted)]">{Math.round(r.duration_ms)}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {benchmarks && (
        <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
          <h3 className="font-semibold text-[var(--text-primary)] mb-3">Benchmark Results</h3>
          <pre className="text-xs text-[var(--text-secondary)] overflow-x-auto">{JSON.stringify(benchmarks, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// HITL Tab
// ──────────────────────────────────────────────────────────────────────────

function HitlTab({ env, orgId }: { env: MultiAgentEnv | null; orgId: string | undefined }) {
  const toast = useToast();
  const [rules, setRules] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, unknown>[]>([]);
  const [actionType, setActionType] = useState("code_execution");
  const [rule, setRule] = useState("always_approve");
  const [busy, setBusy] = useState(false);

  const fetchData = async () => {
    if (!orgId || !env) return;
    try {
      const [rRes, pRes] = await Promise.all([
        api.getHitlRules(orgId, env.env_id),
        api.getPendingApprovals(orgId, env.env_id),
      ]);
      setRules(rRes.rules);
      setPending(pRes.pending);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load HITL data");
    }
  };

  useEffect(() => { fetchData(); }, [env, orgId]);

  const handleSetRule = async () => {
    if (!orgId || !env) return;
    setBusy(true);
    try {
      await api.setHitlRule(orgId, env.env_id, { action_type: actionType, rule });
      fetchData();
      toast.success("Rule updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = async (approvalId: string, approve: boolean) => {
    if (!orgId || !env) return;
    setBusy(true);
    try {
      await api.resolveApproval(orgId, env.env_id, approvalId, approve);
      fetchData();
      toast.success(approve ? "Approved" : "Blocked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  if (!env) {
    return <EmptyState icon={ShieldCheck} title="Select an environment" description="Choose an environment to manage human-in-the-loop approval workflows." />;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Rules */}
        <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl space-y-4">
          <h3 className="font-semibold text-[var(--text-primary)]">HITL Rules</h3>
          <div className="grid grid-cols-2 gap-3">
            <select
              aria-label="Action type"
              className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
              value={actionType}
              onChange={(e) => setActionType(e.target.value)}
            >
              <option value="code_execution">code_execution</option>
              <option value="file_write">file_write</option>
              <option value="network_access">network_access</option>
              <option value="api_key_usage">api_key_usage</option>
              <option value="system_command">system_command</option>
              <option value="message_send">message_send</option>
              <option value="state_update">state_update</option>
              <option value="tool_call">tool_call</option>
            </select>
            <select
              aria-label="Rule"
              className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
              value={rule}
              onChange={(e) => setRule(e.target.value)}
            >
              <option value="always_approve">always_approve</option>
              <option value="approve_if_reviewed">approve_if_reviewed</option>
              <option value="require_human">require_human</option>
              <option value="block">block</option>
            </select>
          </div>
          <Button size="sm" onClick={handleSetRule} loading={busy}>
            Set Rule
          </Button>

          <div className="space-y-1 mt-2">
            {Object.entries(rules).map(([at, r]) => (
              <div key={at} className="flex items-center justify-between p-2 bg-[var(--bg-tertiary)] rounded-lg text-sm">
                <span className="font-mono text-xs">{at}</span>
                <span className={cn(
                  "text-xs px-2 py-0.5 rounded-full font-medium",
                  r === "block" ? "bg-[var(--error-dim)] text-[var(--error)]  " :
                  r === "require_human" ? "bg-[var(--warning-bg)] text-[var(--warning)]  " :
                  "bg-[var(--terminal-faint)] text-[var(--terminal)]  "
                )}>
                  {r}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Pending Approvals */}
        <div className="p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl space-y-4">
          <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-[var(--accent)]" aria-hidden />
            Pending Approvals ({pending.length})
          </h3>
          {pending.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No approvals waiting"
              description="Human-in-the-loop approval requests from the pipeline will appear here when they need review."
              size="sm"
            />
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {pending.map((p, i) => (
                <div key={i} className="p-3 bg-[var(--bg-tertiary)] rounded-lg text-sm">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-[var(--text-primary)]">{String(p.approval_id || p.id || "—")}</span>
                    <span className="text-xs text-[var(--text-muted)]">{String(p.action_type || "—")}</span>
                  </div>
                  <div className="text-xs text-[var(--text-muted)] mb-2">Agent: {String(p.agent_id || "—")}</div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="text-[var(--terminal)] border-[var(--terminal)]/30 hover:bg-[var(--terminal-faint)] " onClick={() => handleResolve(String(p.approval_id || p.id || ""), true)} loading={busy}>
                      <CheckCircle className="w-3.5 h-3.5 mr-1" />
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" className="text-[var(--error)] border-[var(--error-dim)] hover:bg-[var(--error-bg)] " onClick={() => handleResolve(String(p.approval_id || p.id || ""), false)} loading={busy}>
                      <XCircle className="w-3.5 h-3.5 mr-1" />
                      Block
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Shared components
// ──────────────────────────────────────────────────────────────────────────
