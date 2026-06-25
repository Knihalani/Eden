"use client";

/**
 * Phase 3 — Agent detail page (client component).
 *
 * Converted from server component on 2026-06-22. The previous
 * version imported ``@/lib/api`` (a client-only module with
 * ``fetch``, ``AbortController``, the Clerk SDK refresh path, and
 * module-level state) directly into a server component, which
 * (a) bundled Clerk into the server bundle and (b) issued same-
 * origin proxy requests server-side where the Clerk session cookie
 * isn't attached to ``auth().getToken()`` — every data call
 * silently returned empty.
 *
 * Now: this file is a client component that reads the active org
 * from ``useOrg()`` (which already handles Clerk → Eden
 * resolution) and fetches via the same ``agentsApi`` client the
 * rest of the portal uses. Data is loaded in a ``useEffect`` so
 * the page can render the chrome immediately and show a loading
 * skeleton while the agent list comes back.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, Bot, Clock, Code, ExternalLink, Package, PlayCircle, FileCode, Cpu, Upload as UploadIcon, Beaker, Loader2 } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { agentsApi } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { AgentUploadPanel } from "./upload-panel";

function formatRelative(iso?: string | null): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const FRAMEWORK_BADGE: Record<string, string> = {
  langchain: "bg-[var(--accent-faint)] text-[var(--accent)]",
  "openai-agents": "bg-[var(--terminal-faint)] text-[var(--terminal)]",
  raw: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
  none: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
};

interface AgentRecord {
  agent_id: string;
  name?: string;
  framework?: string;
  last_seen_at?: string | null;
  repo_url?: string | null;
}

interface UploadRecord {
  upload_id: string;
  upload_version?: number;
  framework?: string;
  entry_point?: string;
  file_count?: number;
  total_bytes?: number;
  uploaded_at?: string;
}

interface RunsEnvelope {
  runs?: Array<unknown>;
  total?: number;
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const agentId = useMemo(
    () => (params?.id ? decodeURIComponent(params.id) : ""),
    [params?.id],
  );
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;

  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [simRuns, setSimRuns] = useState<RunsEnvelope>({ runs: [], total: 0 });
  const [testRuns, setTestRuns] = useState<RunsEnvelope>({ runs: [], total: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgId || !agentId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      agentsApi
        .list(orgId, { limit: 200 })
        .catch(() => ({ agents: [] as AgentRecord[] })),
      agentsApi.listUploads(orgId, agentId, { limit: 20 }).catch(() => [] as UploadRecord[]),
      agentsApi
        .listSimRuns(orgId, agentId, { limit: 5 })
        .catch(() => ({ runs: [], total: 0 }) as RunsEnvelope),
      agentsApi
        .listTestRuns(orgId, agentId, { limit: 5 })
        .catch(() => ({ runs: [], total: 0 }) as RunsEnvelope),
    ]).then(([agentsResp, ups, sims, tests]) => {
      if (cancelled) return;
      const list = (agentsResp?.agents ?? []) as AgentRecord[];
      setAgent(list.find((a) => a.agent_id === agentId) ?? null);
      // Narrow the BE list into our local UploadRecord shape rather than
      // casting through ``unknown`` (which suppresses the type system).
      // Defensive — fields missing from the wire shape fall back to
      // ``undefined`` rather than crashing the upload panel.
      const narrowed: UploadRecord[] = (ups ?? []).map((u) => ({
        upload_id: (u as { upload_id?: string }).upload_id ?? "",
        upload_version: (u as { upload_version?: number }).upload_version,
        framework: (u as { framework?: string }).framework,
        entry_point: (u as { entry_point?: string }).entry_point,
        file_count: (u as { file_count?: number }).file_count,
        total_bytes: (u as { total_bytes?: number }).total_bytes,
        uploaded_at: (u as { uploaded_at?: string }).uploaded_at,
      }));
      setUploads(narrowed);
      setSimRuns(sims);
      setTestRuns(tests);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, agentId]);

  const isLive = agent?.last_seen_at
    ? Date.now() - new Date(agent.last_seen_at).getTime() < 1000 * 60 * 60 * 24
    : false;
  const repoHost = (() => {
    if (!agent?.repo_url) return null;
    try {
      return new URL(agent.repo_url).hostname.replace(/^www\./, "");
    } catch {
      return agent.repo_url;
    }
  })();

  if (!orgId) {
    return (
      <div className="p-8 text-sm text-[var(--text-muted)]">
        Select an organisation to view this agent.
      </div>
    );
  }

  if (loading && !agent) {
    return (
      <div className="p-8 text-sm text-[var(--text-muted)] flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading agent…
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto page-enter">
      {/* Breadcrumb */}
      <Link
        href="/agents"
        className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
      >
        <ArrowLeft className="w-3 h-3" />
        All agents
      </Link>

      {/* Header card */}
      <Card className="p-6">
        <div className="flex items-start gap-4">
          <div
            className={
              isLive
                ? "p-3 rounded-xl bg-[var(--terminal-faint)] text-[var(--terminal)] flex-shrink-0"
                : "p-3 rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-muted)] flex-shrink-0"
            }
          >
            <Bot className="w-7 h-7" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight">
                {agent?.name ?? agentId}
              </h1>
              {agent?.framework && (
                <span
                  className={`text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded ${
                    FRAMEWORK_BADGE[agent.framework] ?? FRAMEWORK_BADGE.none
                  }`}
                >
                  {agent.framework}
                </span>
              )}
              {isLive && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded bg-[var(--terminal-faint)] text-[var(--terminal)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--terminal)] animate-pulse" />
                  live
                </span>
              )}
            </div>
            <p className="text-xs font-mono text-[var(--text-muted)] mt-1 break-all">
              {agentId}
            </p>
            {agent?.repo_url && (
              <a
                href={agent.repo_url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
              >
                {repoHost}
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>

        {/* Quick stats */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat
            icon={UploadIcon}
            label="Uploads"
            value={String(uploads.length)}
          />
          <Stat
            icon={Beaker}
            label="Sim runs"
            value={String(simRuns.total ?? simRuns.runs?.length ?? 0)}
          />
          <Stat
            icon={PlayCircle}
            label="Test runs"
            value={String(testRuns.total ?? testRuns.runs?.length ?? 0)}
          />
          <Stat
            icon={Clock}
            label="Last seen"
            value={formatRelative(agent?.last_seen_at)}
          />
        </div>
      </Card>

      {/* Quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Link
          href={`/agents/${encodeURIComponent(agentId)}/sim-runs`}
          className="block"
        >
          <Card className="p-4 hover:border-[var(--accent)]/40 hover:bg-[var(--bg-secondary)]/30 transition-colors">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-[var(--accent-faint)] text-[var(--accent)]">
                <Beaker className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-[var(--text-primary)]">
                  Sim runs
                </h3>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  View {simRuns.total ?? simRuns.runs?.length ?? 0} sim run
                  {(simRuns.total ?? simRuns.runs?.length ?? 0) === 1 ? "" : "s"}
                </p>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            </div>
          </Card>
        </Link>
        <Link
          href={`/agents/${encodeURIComponent(agentId)}/test-runs`}
          className="block"
        >
          <Card className="p-4 hover:border-[var(--accent)]/40 hover:bg-[var(--bg-secondary)]/30 transition-colors">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-[var(--terminal-faint)] text-[var(--terminal)]">
                <PlayCircle className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-[var(--text-primary)]">
                  Test runs
                </h3>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  View {testRuns.total ?? testRuns.runs?.length ?? 0} test run
                  {(testRuns.total ?? testRuns.runs?.length ?? 0) === 1 ? "" : "s"}
                </p>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            </div>
          </Card>
        </Link>
      </div>

      {/* Upload panel — the panel accepts the typed
          AgentUpload[] shape; our local state narrows the BE response
          into UploadRecord[] at the fetch boundary above. */}
      <AgentUploadPanel
        orgId={orgId}
        agentId={agentId}
        uploads={uploads as Parameters<typeof AgentUploadPanel>[0]["uploads"]}
      />

      {/* Recent uploads */}
      <section>
        <header className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)] flex items-center gap-2">
            <Package className="w-4 h-4" />
            Recent uploads
          </h2>
          {uploads.length > 0 && (
            <span className="text-xs text-[var(--text-muted)]">
              {uploads.length} total
            </span>
          )}
        </header>
        {uploads.length === 0 ? (
          <Card className="p-8">
            <p className="text-sm text-[var(--text-muted)] text-center">
              No uploads yet. Use{" "}
              <code className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-xs font-mono text-[var(--text-secondary)]">
                eden agent push &lt;dir&gt;
              </code>{" "}
              from the CLI, or upload a tarball above.
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {uploads.slice(0, 6).map((u) => (
              <Card key={u.upload_id} className="p-4">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">
                      v{u.upload_version}
                    </span>
                    {u.framework && (
                      <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        {u.framework}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-[var(--text-muted)] font-mono">
                    {u.uploaded_at?.slice(0, 19).replace("T", " ")}
                  </span>
                </div>
                <div className="space-y-1 text-xs">
                  {u.entry_point && (
                    <p className="text-[var(--text-muted)] flex items-center gap-1.5">
                      <FileCode className="w-3 h-3 flex-shrink-0" />
                      <span className="font-mono truncate">{u.entry_point}</span>
                    </p>
                  )}
                  <p className="text-[var(--text-muted)] flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <Code className="w-3 h-3" />
                      {u.file_count} files
                    </span>
                    <span className="flex items-center gap-1">
                      <Cpu className="w-3 h-3" />
                      {formatBytes(u.total_bytes ?? 0)}
                    </span>
                  </p>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
      {loading && (
        <p className="text-xs text-[var(--text-muted)] text-center pt-4">
          Loading agent data…
        </p>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bot;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40 p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)] font-medium">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <p className="text-base font-semibold text-[var(--text-primary)] mt-1 tabular-nums">
        {value}
      </p>
    </div>
  );
}