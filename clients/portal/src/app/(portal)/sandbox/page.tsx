"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { DataTable } from "@/components/ui/data-table";
import {
  Terminal,
  Play,
  Plus,
  Trash2,
  RotateCcw,
  Clock,
  ChevronDown,
  ChevronUp,
  Copy,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileJson,
  Code2,
  RefreshCw,
  Zap,
  Shield,
  BookOpen,
  Send,
  History,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { StatCard } from "@/components/ui/stat-card";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";

// ─── Types ──────────────────────────────────────────────────────────────────

interface SandboxSession {
  session_id: string;
  status: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  request_count: number;
  max_requests: number;
  endpoints_available: string[];
}

interface RequestLogEntry {
  request_id?: string;
  timestamp: string;
  method: string;
  endpoint: string;
  status: number;
  status_code: number;
  duration_ms: number;
  requested_at?: string;
}

interface SandboxDoc {
  title: string;
  version: string;
  description: string;
  ttl_seconds: number;
  max_requests_per_session: number;
  max_active_sessions: number;
  endpoints: Array<{
    method: string;
    path: string;
    description: string;
    request_schema?: Record<string, unknown>;
    response_schema?: Record<string, unknown>;
    example?: Record<string, unknown>;
  }>;
  mock_behaviors: Record<string, string>;
}

interface SandboxResponse {
  status: number;
  status_code: number;
  body: string | Record<string, unknown>;
  duration_ms: number;
  warnings: string[] | null;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SandboxPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SandboxSession[]>([]);
  const [activeSession, setActiveSession] = useState<SandboxSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [requestLog, setRequestLog] = useState<RequestLogEntry[]>([]);
  const [docs, setDocs] = useState<SandboxDoc | null>(null);
  const [activeTab, setActiveTab] = useState<"playground" | "docs" | "logs">("playground");

  // Playground state
  const [selectedEndpoint, setSelectedEndpoint] = useState("");
  const [requestBody, setRequestBody] = useState("{}");
  const [requestMethod, setRequestMethod] = useState("POST");
  const [executing, setExecuting] = useState(false);
  const [lastResponse, setLastResponse] = useState<{
    status_code: number;
    body: Record<string, unknown> | string;
    duration_ms: number;
    warnings: string[] | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const bodyEditorRef = useRef<HTMLTextAreaElement>(null);

  // ── Load sessions + docs on mount ──────────────────────────────────────

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const res = await api.listSandboxSessions();
      setSessions(res.sessions);
      if (res.sessions.length > 0 && !activeSession) {
        setActiveSession(res.sessions[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [activeSession]);

  const loadDocs = useCallback(async () => {
    try {
      const res = await api.getSandboxDocs();
      // The API returns the docs page with title/version/endpoints;
      // the local SandboxDoc type carries extra fields the BE doesn't
      // surface. Map at the boundary with sensible defaults.
      setDocs({
        title: res.title,
        version: res.version,
        description: "",
        ttl_seconds: 0,
        max_requests_per_session: 0,
        max_active_sessions: 0,
        endpoints: res.endpoints.map((e) => ({
          method: e.method,
          path: e.path,
          description: e.description,
          request_schema: e.request_schema,
          response_schema: e.response_schema,
        })),
        mock_behaviors: {},
      });
    } catch {
      // docs are optional
    }
  }, []);

  useEffect(() => {
    loadSessions();
    loadDocs();
  }, [loadSessions, loadDocs]);

  // ── Load request log when active session changes ───────────────────────

  const loadRequestLog = useCallback(async (sessionId: string) => {
    try {
      const res = await api.getSandboxRequestLog(sessionId);
      // The API returns ``request_id/status/requested_at``; the
      // local RequestLogEntry uses ``timestamp/status_code``. Map
      // at the boundary so consumers stay on the legacy names.
      setRequestLog(
        res.entries.map((e) => ({
          request_id: e.request_id,
          timestamp: e.requested_at,
          method: e.method,
          endpoint: e.endpoint,
          status: e.status,
          status_code: e.status,
          duration_ms: e.duration_ms,
          requested_at: e.requested_at,
        })),
      );
    } catch {
      setRequestLog([]);
    }
  }, []);

  useEffect(() => {
    if (activeSession) {
      loadRequestLog(activeSession.session_id);
    }
  }, [activeSession, loadRequestLog]);

  // ── Create session ─────────────────────────────────────────────────────

  const handleCreateSession = async () => {
    setCreating(true);
    setError("");
    try {
      const res = await api.createSandboxSession({ name: `Sandbox ${sessions.length + 1}` });
      const newSession: SandboxSession = {
        session_id: res.session_id,
        status: "active",
        created_at: res.created_at,
        last_used_at: res.created_at,
        expires_at: res.expires_at,
        request_count: res.request_count,
        max_requests: res.max_requests,
        endpoints_available: [],
      };
      setSessions((prev) => [newSession, ...prev]);
      setActiveSession(newSession);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
    } finally {
      setCreating(false);
    }
  };

  // ── Delete session ─────────────────────────────────────────────────────

  const handleDeleteSession = async (sessionId: string) => {
    if (!confirm("Delete this sandbox session? All request logs will be lost.")) return;
    try {
      await api.deleteSandboxSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
      if (activeSession?.session_id === sessionId) {
        setActiveSession(null);
        setRequestLog([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete session");
    }
  };

  // ── Reset session ──────────────────────────────────────────────────────

  const handleResetSession = async (sessionId: string) => {
    try {
      const res = await api.resetSandboxSession(sessionId, false);
      setSessions((prev) =>
        prev.map((s) =>
          s.session_id === sessionId ? { ...s, request_count: 0 } : s
        )
      );
      if (activeSession?.session_id === sessionId) {
        setActiveSession((prev) => (prev ? { ...prev, request_count: 0 } : null));
        setRequestLog([]);
      }
      // show toast-like feedback
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset session");
    }
  };

  // ── Execute request ────────────────────────────────────────────────────

  const handleExecute = async () => {
    if (!activeSession) return;
    setExecuting(true);
    setLastResponse(null);
    setError("");
    try {
      let parsedBody: Record<string, unknown> = {};
      try {
        parsedBody = JSON.parse(requestBody);
      } catch {
        setError("Request body is not valid JSON");
        return;
      }

      const res = await api.executeSandboxRequest(activeSession.session_id, {
        endpoint: selectedEndpoint,
        method: requestMethod,
        body: parsedBody,
      });

      setLastResponse({
        status_code: res.status,
        body: res.body,
        duration_ms: res.duration_ms,
        warnings: null,
      });
      setActiveSession((prev) =>
        prev ? { ...prev, request_count: prev.request_count + 1 } : null
      );
      setSessions((prev) =>
        prev.map((s) =>
          s.session_id === activeSession.session_id
            ? { ...s, request_count: s.request_count + 1 }
            : s
        )
      );
      loadRequestLog(activeSession.session_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Execution failed");
    } finally {
      setExecuting(false);
    }
  };

  // ── Copy response ────────────────────────────────────────────────────────

  const handleCopyResponse = async () => {
    if (!lastResponse) return;
    const text =
      typeof lastResponse.body === "string"
        ? lastResponse.body
        : JSON.stringify(lastResponse.body, null, 2);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Preset endpoints from docs ─────────────────────────────────────────

  const presetEndpoints = docs?.endpoints ?? [
    { method: "POST", path: "/v1/jobs", description: "Create a job" },
    { method: "GET", path: "/v1/jobs/job_sandbox_001", description: "Get job status" },
    { method: "POST", path: "/v1/environments", description: "Create an environment" },
    { method: "GET", path: "/v1/environments/env_sandbox_001", description: "Get environment" },
    { method: "POST", path: "/v1/benchmarks", description: "Create a benchmark" },
    { method: "POST", path: "/v1/benchmarks/bench_sandbox_001/execute", description: "Run benchmark" },
    { method: "POST", path: "/v1/datasets", description: "Create a dataset" },
    { method: "GET", path: "/v1/observability/traces", description: "List traces" },
    { method: "GET", path: "/health", description: "Health check" },
  ];

  const handleSelectPreset = (method: string, path: string) => {
    setRequestMethod(method);
    setSelectedEndpoint(path);
    const example =
      docs?.endpoints.find((e) => e.path === path && e.method === method)?.example;
    setRequestBody(
      example ? JSON.stringify(example, null, 2) : "{}"
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 page-enter">
      <PageHeader
        title="API Sandbox"
        subtitle="Free, isolated environment for testing Eden APIs. No quotas consumed."
        icon={Terminal}
        actions={
          <div className="flex items-center gap-3">
            <button
              onClick={loadSessions}
              className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-secondary)] bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
            <button
              onClick={handleCreateSession}
              disabled={creating || sessions.length >= (docs?.max_active_sessions ?? 3)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-[var(--bg-base)] bg-[var(--accent)] rounded-lg hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              New Session
            </button>
          </div>
        }
      />

      {/* Error banner */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="mb-4 bg-[var(--error-bg)] text-[var(--error)] px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20"
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span className="text-sm">{error}</span>
            <button
              onClick={() => setError("")}
              className="ml-auto p-1 hover:bg-[var(--error)]/10 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <StatCard
          icon={Shield}
          title="Active Sessions"
          value={String(sessions.length)}
          subtitle={`Max ${docs?.max_active_sessions ?? 3}`}
          accent="accent"
        />
        <StatCard
          icon={Zap}
          title="Total Requests"
          value={String(sessions.reduce((a, s) => a + s.request_count, 0))}
          subtitle={`Limit ${docs?.max_requests_per_session ?? 100}/session`}
          accent="terminal"
        />
        <StatCard
          icon={Clock}
          title="Session TTL"
          value={`${Math.floor((docs?.ttl_seconds ?? 3600) / 60)}m`}
          subtitle="Auto-expires"
          accent="warning"
        />
        <StatCard
          icon={BookOpen}
          title="Mocked Endpoints"
          value={String(presetEndpoints.length)}
          subtitle="Available to test"
          accent="neutral"
        />
      </div>

      {/* Session selector */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">
          Your Sessions
        </h2>
        {loading && sessions.length === 0 ? (
          <div className="flex items-center gap-2 text-[var(--text-muted)] py-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading sessions...</span>
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={Terminal}
            title="No active sessions"
            description="Create a sandbox session to start testing Eden APIs."
            size="lg"
            action={
              <button
                onClick={handleCreateSession}
                disabled={creating}
                className="mt-4 flex items-center gap-2 px-4 py-2 text-sm font-medium text-[var(--bg-base)] bg-[var(--accent)] rounded-lg hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
              >
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Create Session
              </button>
            }
          />
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {sessions.map((session) => (
              <SessionCard
                key={session.session_id}
                session={session}
                active={activeSession?.session_id === session.session_id}
                onSelect={() => setActiveSession(session)}
                onDelete={() => handleDeleteSession(session.session_id)}
                onReset={() => handleResetSession(session.session_id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Tabs + Content */}
      {activeSession && (
        <div>
          {/* Tab bar */}
          <div
            role="tablist"
            aria-label="Sandbox session view"
            className="flex items-center gap-1 mb-4 border-b border-[var(--border-default)]"
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              const order = ["playground", "logs", "docs"] as const;
              const idx = order.indexOf(activeTab);
              const next = e.key === "ArrowRight" ? (idx + 1) % order.length : (idx - 1 + order.length) % order.length;
              setActiveTab(order[next]);
            }}
          >
            {(["playground", "logs", "docs"] as const).map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                aria-controls={`sandbox-panel-${tab}`}
                id={`sandbox-tab-${tab}`}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize",
                  activeTab === tab
                    ? "text-[var(--accent)] border-[var(--accent)]"
                    : "text-[var(--text-muted)] border-transparent hover:text-[var(--text-secondary)]"
                )}
              >
                {tab === "playground" && (
                  <span className="flex items-center gap-1.5">
                    <Play className="w-3.5 h-3.5" /> Playground
                  </span>
                )}
                {tab === "logs" && (
                  <span className="flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5" /> Request Log
                  </span>
                )}
                {tab === "docs" && (
                  <span className="flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5" /> Docs
                  </span>
                )}
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            {activeTab === "playground" && (
              <motion.div
                key="playground"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18 }}
                className="space-y-4"
              >
                <div className="grid lg:grid-cols-2 gap-4">
                  {/* Request panel */}
                  <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                        <Send className="w-4 h-4 text-[var(--accent)]" />
                        Request
                      </h3>
                      <span className="text-xs text-[var(--text-muted)]">
                        {activeSession.request_count} / {activeSession.max_requests} requests
                      </span>
                    </div>
                    <div className="p-4 space-y-4">
                      {/* Method + endpoint */}
                      <div className="flex gap-2">
                        <select
                          value={requestMethod}
                          onChange={(e) => setRequestMethod(e.target.value)}
                          className="px-3 py-2 text-sm bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                        >
                          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={selectedEndpoint}
                          onChange={(e) => setSelectedEndpoint(e.target.value)}
                          placeholder="/v1/jobs"
                          className="flex-1 px-3 py-2 text-sm bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                        />
                      </div>

                      {/* Presets */}
                      <div>
                        <label className="text-xs font-medium text-[var(--text-muted)] mb-2 block">
                          Quick Select
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {presetEndpoints.map((ep) => (
                            <button
                              key={`${ep.method}-${ep.path}`}
                              onClick={() => handleSelectPreset(ep.method, ep.path)}
                              className={cn(
                                "px-2.5 py-1 text-xs rounded-md border transition-colors",
                                selectedEndpoint === ep.path && requestMethod === ep.method
                                  ? "bg-[var(--accent-faint)] text-[var(--accent)] border-[var(--accent)]/30"
                                  : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[var(--accent)]/30"
                              )}
                              title={ep.description}
                            >
                              {ep.method} {ep.path}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Body editor */}
                      <div>
                        <label className="text-xs font-medium text-[var(--text-muted)] mb-2 block">
                          Request Body (JSON)
                        </label>
                        <textarea
                          ref={bodyEditorRef}
                          value={requestBody}
                          onChange={(e) => setRequestBody(e.target.value)}
                          rows={10}
                          className="w-full px-3 py-2 text-sm font-mono bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 resize-y"
                        />
                      </div>

                      {/* Execute */}
                      <button
                        onClick={handleExecute}
                        disabled={executing || !selectedEndpoint || activeSession.request_count >= activeSession.max_requests}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-[var(--bg-base)] bg-[var(--accent)] rounded-lg hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {executing ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Executing...
                          </>
                        ) : (
                          <>
                            <Play className="w-4 h-4" />
                            Execute Request
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Response panel */}
                  <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden flex flex-col">
                    <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                        <FileJson className="w-4 h-4 text-[var(--accent)]" />
                        Response
                      </h3>
                      {lastResponse && (
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "text-xs font-medium px-2 py-0.5 rounded",
                              lastResponse.status_code < 300
                                ? "bg-[var(--terminal-faint)] text-[var(--terminal)]  "
                                : lastResponse.status_code < 400
                                  ? "bg-[var(--warning-bg)] text-[var(--warning)]  "
                                  : "bg-[var(--error-dim)] text-[var(--error)]  "
                            )}
                          >
                            {lastResponse.status_code}
                          </span>
                          <span className="text-xs text-[var(--text-muted)]">
                            {lastResponse.duration_ms}ms
                          </span>
                          <button
                            onClick={handleCopyResponse}
                            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-md transition-colors"
                            title="Copy response"
                            aria-label={copied ? "Response copied" : "Copy response"}
                          >
                            {copied ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-[var(--terminal)]" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 p-4 min-h-[320px]">
                      {lastResponse ? (
                        <div className="space-y-3">
                          {lastResponse.warnings && lastResponse.warnings.length > 0 && (
                            <div className="bg-[var(--warning-bg)]  border border-[var(--warning-dim)]  rounded-lg p-3">
                              <p className="text-xs font-medium text-[var(--warning)]  mb-1">
                                Warnings
                              </p>
                              <ul className="space-y-1">
                                {lastResponse.warnings.map((w, i) => (
                                  <li key={i} className="text-xs text-[var(--warning)]  flex items-start gap-1.5">
                                    <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                    {w}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <pre className="text-xs font-mono bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg p-3 overflow-auto max-h-[400px] text-[var(--text-primary)]">
                            {typeof lastResponse.body === "string"
                              ? lastResponse.body
                              : JSON.stringify(lastResponse.body, null, 2)}
                          </pre>
                        </div>
                      ) : (
                        <div className="h-full flex flex-col items-center justify-center text-[var(--text-muted)]">
                          <Code2 className="w-10 h-10 mb-3 opacity-30" />
                          <p className="text-sm">Execute a request to see the response</p>
                          <p className="text-xs mt-1 opacity-60">
                            Responses are mocked — no real LLM calls are made
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === "logs" && (
              <motion.div
                key="logs"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18 }}
              >
                <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                      <History className="w-4 h-4 text-[var(--accent)]" />
                      Request Log
                    </h3>
                    <span className="text-xs text-[var(--text-muted)]">
                      {requestLog.length} entries
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <DataTable
                      columns={[
                        {
                          key: "timestamp",
                          header: "Time",
                          sortable: true,
                          cell: (entry) => (
                            <span className="text-[var(--text-secondary)] whitespace-nowrap">
                              {new Date(entry.timestamp).toLocaleTimeString()}
                            </span>
                          ),
                        },
                        {
                          key: "method",
                          header: "Method",
                          cell: (entry) => (
                            <span
                              className={cn(
                                "text-xs font-medium px-1.5 py-0.5 rounded",
                                entry.method === "GET" && "bg-[var(--accent-faint)] text-[var(--accent)]",
                                entry.method === "POST" && "bg-[var(--terminal-faint)] text-[var(--terminal)]",
                                entry.method === "PUT" && "bg-[var(--warning-bg)] text-[var(--warning)]",
                                entry.method === "PATCH" && "bg-[var(--accent-faint)] text-[var(--accent)]",
                                entry.method === "DELETE" && "bg-[var(--error-dim)] text-[var(--error)]",
                              )}
                            >
                              {entry.method}
                            </span>
                          ),
                        },
                        {
                          key: "endpoint",
                          header: "Endpoint",
                          cell: (entry) => (
                            <span className="text-[var(--text-primary)] font-mono text-xs truncate max-w-[200px] inline-block">
                              {entry.endpoint}
                            </span>
                          ),
                        },
                        {
                          key: "status_code",
                          header: "Status",
                          sortable: true,
                          align: "right",
                          cell: (entry) => (
                            <span
                              className={cn(
                                "text-xs font-medium",
                                entry.status_code < 300
                                  ? "text-[var(--terminal)]"
                                  : entry.status_code < 400
                                    ? "text-[var(--warning)]"
                                    : "text-[var(--error)]",
                              )}
                            >
                              {entry.status_code}
                            </span>
                          ),
                        },
                        {
                          key: "duration_ms",
                          header: "Duration",
                          sortable: true,
                          align: "right",
                          cell: (entry) => (
                            <span className="text-[var(--text-muted)] whitespace-nowrap">{entry.duration_ms}ms</span>
                          ),
                        },
                      ]}
                      rows={requestLog}
                      rowKey={(_entry, i) => String(i)}
                      defaultSort={{ key: "timestamp", direction: "desc" }}
                      emptyTitle="No requests yet"
                      emptyDescription="Send a request above to populate the log."
                      emptyIcon={History}
                      pageSize={25}
                    />
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === "docs" && (
              <motion.div
                key="docs"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18 }}
              >
                <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-[var(--border-default)]">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                      <BookOpen className="w-4 h-4 text-[var(--accent)]" />
                      Sandbox API Documentation
                    </h3>
                  </div>
                  <div className="p-4 space-y-6">
                    <div className="grid sm:grid-cols-3 gap-4">
                      <DocStat label="Session TTL" value={`${Math.floor((docs?.ttl_seconds ?? 3600) / 60)} minutes`} />
                      <DocStat label="Max Requests" value={`${docs?.max_requests_per_session ?? 100} / session`} />
                      <DocStat label="Max Sessions" value={`${docs?.max_active_sessions ?? 3} / user`} />
                    </div>

                    <div>
                      <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Available Endpoints</h4>
                      <div className="space-y-2">
                        {presetEndpoints.map((ep) => (
                          <div
                            key={`${ep.method}-${ep.path}`}
                            className="flex items-center gap-3 p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-default)] hover:border-[var(--accent)]/30 transition-colors cursor-pointer"
                            onClick={() => {
                              handleSelectPreset(ep.method, ep.path);
                              setActiveTab("playground");
                            }}
                          >
                            <span
                              className={cn(
                                "text-xs font-bold px-2 py-0.5 rounded min-w-[52px] text-center",
                                ep.method === "GET" && "bg-[var(--accent-faint)] text-[var(--accent)]  ",
                                ep.method === "POST" && "bg-[var(--terminal-faint)] text-[var(--terminal)]  ",
                                ep.method === "PUT" && "bg-[var(--warning-bg)] text-[var(--warning)]  ",
                                ep.method === "DELETE" && "bg-[var(--error-dim)] text-[var(--error)]  "
                              )}
                            >
                              {ep.method}
                            </span>
                            <code className="text-xs font-mono text-[var(--text-primary)]">{ep.path}</code>
                            <span className="text-xs text-[var(--text-muted)] ml-auto">{ep.description}</span>
                            <Play className="w-3.5 h-3.5 text-[var(--accent)] opacity-0 group-hover:opacity-100" />
                          </div>
                        ))}
                      </div>
                    </div>

                    {docs?.mock_behaviors && Object.keys(docs.mock_behaviors).length > 0 && (
                      <div>
                        <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Mock Behaviors</h4>
                        <div className="space-y-2">
                          {Object.entries(docs.mock_behaviors).map(([key, desc]) => (
                            <div key={key} className="flex items-start gap-3 p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-default)]">
                              <Zap className="w-4 h-4 text-[var(--accent)] mt-0.5 flex-shrink-0" />
                              <div>
                                <p className="text-sm font-medium text-[var(--text-primary)]">{key}</p>
                                <p className="text-xs text-[var(--text-muted)]">{desc}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────
// (Local StatCard deleted; use StatCard from ui/stat-card)

function SessionCard({
  session,
  active,
  onSelect,
  onDelete,
  onReset,
}: {
  session: SandboxSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onReset: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const expired = session.status === "expired";
  const usagePct = Math.round((session.request_count / session.max_requests) * 100);

  return (
    <div
      className={cn(
        "relative flex-shrink-0 w-72 bg-[var(--bg-primary)] border rounded-xl overflow-hidden transition-all cursor-pointer",
        active
          ? "border-[var(--accent)] shadow-sm ring-1 ring-[var(--accent)]/20"
          : "border-[var(--border-default)] hover:border-[var(--accent)]/30"
      )}
      onClick={onSelect}
    >
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "w-2.5 h-2.5 rounded-full",
                expired ? "bg-[var(--error)]" : "bg-[var(--terminal)]"
              )}
            />
            <span className="text-sm font-medium text-[var(--text-primary)] truncate">
              {session.session_id.slice(0, 12)}...
            </span>
          </div>
          <span
            className={cn(
              "text-[10px] font-medium px-1.5 py-0.5 rounded",
              expired
                ? "bg-[var(--error-dim)] text-[var(--error)]  "
                : "bg-[var(--terminal-faint)] text-[var(--terminal)]  "
            )}
          >
            {expired ? "Expired" : "Active"}
          </span>
        </div>

        <div className="space-y-2">
          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-[var(--text-muted)]">Requests</span>
              <span className="text-[var(--text-primary)] font-medium">
                {session.request_count} / {session.max_requests}
              </span>
            </div>
            <div className="h-1.5 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  usagePct > 80 ? "bg-[var(--error)]" : usagePct > 50 ? "bg-[var(--warning)]" : "bg-[var(--accent)]"
                )}
                style={{ width: `${usagePct}%` }}
              />
            </div>
          </div>

          <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <Clock className="w-3 h-3" />
            <span>Expires {new Date(session.expires_at).toLocaleTimeString()}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[var(--border-default)]">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReset();
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded transition-colors"
            title="Reset session"
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors ml-auto"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            Details
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--error)] hover:bg-[var(--error-bg)]  rounded transition-colors"
            title="Delete session"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>

        {/* Expanded details */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="pt-3 mt-3 border-t border-[var(--border-default)] space-y-1.5">
                <DetailRow label="Session ID" value={session.session_id} />
                <DetailRow label="Created" value={new Date(session.created_at).toLocaleString()} />
                <DetailRow label="Last Used" value={new Date(session.last_used_at).toLocaleString()} />
                <DetailRow label="Expires" value={new Date(session.expires_at).toLocaleString()} />
                {session.endpoints_available.length > 0 && (
                  <div>
                    <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Endpoints</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {session.endpoints_available.map((ep) => (
                        <span key={ep} className="text-[10px] px-1.5 py-0.5 bg-[var(--bg-secondary)] rounded text-[var(--text-secondary)]">
                          {ep}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">{label}</span>
      <span className="text-xs text-[var(--text-secondary)] font-mono truncate max-w-[150px]" title={value}>
        {value}
      </span>
    </div>
  );
}

function DocStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg p-3 text-center">
      <p className="text-lg font-bold text-[var(--text-primary)]">{value}</p>
      <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mt-1">{label}</p>
    </div>
  );
}
