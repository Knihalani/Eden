"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import {
  Download,
  Loader2,
  Plus,
  Trash2,
  Cloud,
  Database,
  Play,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Calendar,
  FileArchive,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";

// ────────────────────────────────────────────────────────────────────
// Catalog (must match eden.api.routes.export_destinations.DATA_TYPES
// and FORMATS). Hard-coded here so the portal renders even when the
// list endpoint is offline; the server still validates on write.
// ────────────────────────────────────────────────────────────────────

const DATA_TYPES = [
  { id: "traces", label: "Traces", description: "OpenTelemetry trace spans (telemetry_events)" },
  { id: "judge_scores", label: "Judge scores", description: "LLM-as-judge scores per trace" },
  { id: "audit_log", label: "Audit log", description: "Org audit-log rows" },
  { id: "usage_events", label: "Usage events", description: "Per-tenant usage metering" },
  { id: "insights", label: "Insights", description: "Detector-generated insights" },
  { id: "telemetry_events", label: "Telemetry events", description: "Raw telemetry rows" },
];

const FORMATS = [
  { id: "csv", label: "CSV" },
  { id: "parquet", label: "Parquet" },
  { id: "jsonl", label: "JSONL" },
];

const DESTINATION_TYPES = [
  { id: "s3", label: "Amazon S3" },
  { id: "gcs", label: "Google Cloud Storage" },
];

const CRON_PRESETS = [
  { id: "", label: "One-shot (no schedule)" },
  { id: "0 0 * * *", label: "Daily at midnight UTC" },
  { id: "0 0 * * 0", label: "Weekly on Sunday" },
  { id: "0 0 1 * *", label: "Monthly on the 1st" },
];

// ────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────

interface ExportsTabProps {
  orgId: string;
  canManage: boolean;
}

export function ExportsTab({ orgId, canManage }: ExportsTabProps) {
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  type Destination = Awaited<ReturnType<typeof api.listExportDestinations>>[number];
  type Schedule = Awaited<ReturnType<typeof api.listExportSchedules>>[number];
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loadingDest, setLoadingDest] = useState(true);
  const [loadingSched, setLoadingSched] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ id: string; status: "ok" | "err"; message: string } | null>(null);

  // Forms
  const [showDestForm, setShowDestForm] = useState(false);
  const [showSchedForm, setShowSchedForm] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function loadAll() {
    if (!orgId) return;
    setLoadingDest(true);
    setLoadingSched(true);
    setError(null);
    try {
      const [d, s] = await Promise.all([
        api.listExportDestinations(orgId),
        api.listExportSchedules(orgId),
      ]);
      setDestinations(d);
      setSchedules(s);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load exports";
      setError(message);
    } finally {
      setLoadingDest(false);
      setLoadingSched(false);
    }
  }

  async function handleRunNow(scheduleId: string) {
    if (!orgId) return;
    setRunning(scheduleId);
    setRunResult(null);
    try {
      const result = await api.runExportNow(orgId, scheduleId);
      setRunResult({
        id: scheduleId,
        status: "ok",
        message: `Wrote ${result.bytes_written} bytes to ${result.destination}`,
      });
      await loadAll();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Export failed";
      setRunResult({ id: scheduleId, status: "err", message });
    } finally {
      setRunning(null);
    }
  }

  if (!orgId) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage exports
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="p-6 bg-[var(--error-bg)] rounded-lg border border-[var(--error)]/20">
        <p className="text-sm text-[var(--error)]">
          You do not have permission to manage exports. Contact your organization admin.
        </p>
      </div>
    );
  }

  const destColumns: DataTableColumn<Destination>[] = [
    { key: "name", header: "Name", sortable: true, cell: (d) => <span className="text-sm font-medium">{d.name}</span> },
    {
      key: "type",
      header: "Type",
      cell: (d) => <span className="px-2 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs uppercase">{d.type}</span>,
    },
    {
      key: "bucket",
      header: "Bucket",
      cell: (d) => <span className="text-sm font-mono text-[var(--text-muted)]">{String(d.config?.bucket || "—")}</span>,
    },
    {
      key: "created_at",
      header: "Created",
      sortable: true,
      cell: (d) => <span className="text-xs text-[var(--text-muted)]">{d.created_at ? new Date(d.created_at).toLocaleString() : "—"}</span>,
    },
    {
      key: "destination_id",
      header: "",
      align: "right",
      cell: (d) => (
        <button
          onClick={async () => {
            const ok = await confirm({
              title: `Delete destination "${d.name}"?`,
              confirmLabel: "Delete",
              variant: "destructive",
            });
            if (!ok) return;
            try {
              await api.deleteExportDestination(orgId, d.destination_id);
              await loadAll();
            } catch (err: unknown) {
              toast.error(err instanceof Error ? err.message : "Failed to delete");
            }
          }}
          className="p-1.5 text-[var(--error)] hover:bg-[var(--error-bg)] rounded"
          title="Delete destination"
          aria-label={`Delete destination ${d.name}`}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      ),
    },
  ];

  const schedColumns: DataTableColumn<Schedule>[] = [
    {
      key: "data_type",
      header: "Data",
      cell: (s) => {
        const dest = destinations.find((d) => d.destination_id === s.destination_id);
        return (
          <>
            <span className="px-2 py-0.5 bg-[var(--bg-tertiary)] rounded text-xs mr-1">{s.data_type}</span>
            <span className="text-xs text-[var(--text-muted)]">→ {dest?.name || "download"}</span>
          </>
        );
      },
    },
    { key: "format", header: "Format", cell: (s) => <span className="text-sm text-[var(--text-secondary)] uppercase">{s.format}</span> },
    {
      key: "cron_expression",
      header: "Schedule",
      cell: (s) => <span className="text-sm font-mono text-[var(--text-muted)]">{s.cron_expression || "one-shot"}</span>,
    },
    {
      key: "last_run_at",
      header: "Last run",
      sortable: true,
      cell: (s) => <span className="text-xs text-[var(--text-muted)]">{s.last_run_at ? new Date(s.last_run_at).toLocaleString() : "—"}</span>,
    },
    {
      key: "schedule_id",
      header: "",
      align: "right",
      cell: (s) => (
        <div className="flex justify-end gap-1">
          <button
            onClick={() => handleRunNow(s.schedule_id)}
            disabled={running === s.schedule_id}
            className="p-1.5 text-[var(--accent)] hover:bg-[var(--bg-tertiary)] rounded disabled:opacity-50"
            title="Run now"
            aria-label="Run now"
          >
            {running === s.schedule_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          </button>
          <button
            onClick={async () => {
              const ok = await confirm({
                title: "Delete this schedule?",
                confirmLabel: "Delete",
                variant: "destructive",
              });
              if (!ok) return;
              try {
                await api.deleteExportSchedule(orgId, s.schedule_id);
                await loadAll();
              } catch (err: unknown) {
                toast.error(err instanceof Error ? err.message : "Failed to delete");
              }
            }}
            className="p-1.5 text-[var(--error)] hover:bg-[var(--error-bg)] rounded"
            title="Delete schedule"
            aria-label="Delete schedule"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <FileArchive className="w-5 h-5 text-[var(--text-muted)]" />
            Exports
          </h2>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Stream your observability data into S3 or GCS for long-term analysis. One-shot
            or recurring schedules, three formats (CSV, Parquet, JSONL).
          </p>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-[var(--error-bg)] rounded-lg border border-[var(--error)]/20 text-sm text-[var(--error)] flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {runResult && (
        <div
          className={cn(
            "p-3 rounded-lg border text-sm flex items-center gap-2",
            runResult.status === "ok"
              ? "bg-[var(--success-bg)] border-[var(--success)]/30 text-[var(--success)]"
              : "bg-[var(--error-bg)] border-[var(--error)]/30 text-[var(--error)]"
          )}
        >
          {runResult.status === "ok" ? (
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          ) : (
            <XCircle className="w-4 h-4 flex-shrink-0" />
          )}
          {runResult.message}
        </div>
      )}

      {/* Destinations */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Cloud className="w-4 h-4 text-[var(--text-muted)]" />
            Destinations
          </h3>
          <button
            onClick={() => setShowDestForm((v) => !v)}
            className="px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:opacity-90 flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            {showDestForm ? "Cancel" : "Add destination"}
          </button>
        </div>

        {showDestForm && (
          <DestinationForm
            orgId={orgId}
            onSaved={async () => {
              setShowDestForm(false);
              await loadAll();
            }}
            onCancel={() => setShowDestForm(false)}
          />
        )}

        {loadingDest ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : destinations.length === 0 ? (
          <div className="text-center py-8 text-sm text-[var(--text-muted)] border border-dashed border-[var(--border-default)] rounded-xl">
            No destinations yet. Add an S3 or GCS bucket to start exporting.
          </div>
        ) : (
          <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] overflow-hidden">
            <DataTable
              columns={destColumns}
              rows={destinations}
              rowKey={(d) => d.destination_id}
              defaultSort={{ key: "name", direction: "asc" }}
              emptyTitle="No destinations yet"
              emptyDescription="Add an S3 or GCS bucket to start exporting."
              emptyIcon={Cloud}
              pageSize={25}
            />
          </div>
        )}
      </section>

      {/* Schedules */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Calendar className="w-4 h-4 text-[var(--text-muted)]" />
            Schedules
          </h3>
          <button
            onClick={() => setShowSchedForm((v) => !v)}
            className="px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:opacity-90 flex items-center gap-1.5"
            disabled={destinations.length === 0}
            title={destinations.length === 0 ? "Add a destination first" : ""}
          >
            <Plus className="w-4 h-4" />
            {showSchedForm ? "Cancel" : "New schedule"}
          </button>
        </div>

        {showSchedForm && (
          <ScheduleForm
            orgId={orgId}
            destinations={destinations}
            onSaved={async () => {
              setShowSchedForm(false);
              await loadAll();
            }}
            onCancel={() => setShowSchedForm(false)}
          />
        )}

        {loadingSched ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : schedules.length === 0 ? (
          <div className="text-center py-8 text-sm text-[var(--text-muted)] border border-dashed border-[var(--border-default)] rounded-xl">
            No schedules yet. Recurring or one-shot, you decide.
          </div>
        ) : (
          <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] overflow-hidden">
            <DataTable
              columns={schedColumns}
              rows={schedules}
              rowKey={(s) => s.schedule_id}
              defaultSort={{ key: "last_run_at", direction: "desc" }}
              emptyTitle="No schedules yet"
              emptyDescription="Recurring or one-shot, you decide."
              emptyIcon={Calendar}
              pageSize={25}
            />
          </div>
        )}
      </section>

      {/* Legacy GDPR fallback */}
      <section>
        <LegacyExportFallback orgId={orgId} />
      </section>
      {ConfirmDialog}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Destination form
// ────────────────────────────────────────────────────────────────────

function DestinationForm({
  orgId,
  onSaved,
  onCancel,
}: {
  orgId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"s3" | "gcs">("s3");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSave() {
    if (!name.trim() || !bucket.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      const config: Record<string, unknown> = { bucket };
      if (region) config.region = region;
      const credentials: Record<string, unknown> =
        type === "s3"
          ? { access_key_id: accessKeyId, secret_access_key: secretAccessKey }
          : { client_email: accessKeyId, private_key: secretAccessKey };

      await api.createExportDestination(orgId, {
        name: name.trim(),
        type,
        config,
        credentials,
      });
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to create destination");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] space-y-3">
      <h4 className="text-sm font-semibold">New destination</h4>
      {err && (
        <div className="p-2 bg-[var(--error-bg)] rounded text-xs text-[var(--error)]">{err}</div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Destination name (e.g. 'prod-archive')"
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as "s3" | "gcs")}
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
        >
          {DESTINATION_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder="Bucket name"
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm font-mono"
        />
        <input
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          placeholder="Region (optional, e.g. us-east-1)"
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
        />
        <input
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
          placeholder={type === "s3" ? "Access key ID" : "Service account email"}
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm font-mono"
        />
        <input
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
          placeholder={type === "s3" ? "Secret access key" : "Private key (PEM)"}
          type="password"
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm font-mono"
        />
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm hover:bg-[var(--bg-tertiary)] rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !name.trim() || !bucket.trim()}
          className="px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
          Save destination
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Schedule form
// ────────────────────────────────────────────────────────────────────

function ScheduleForm({
  orgId,
  destinations,
  onSaved,
  onCancel,
}: {
  orgId: string;
  destinations: any[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [destinationId, setDestinationId] = useState<string>(destinations[0]?.destination_id || "");
  const [dataType, setDataType] = useState("traces");
  const [format, setFormat] = useState("jsonl");
  const [cron, setCron] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setErr(null);
    try {
      await api.createExportSchedule(orgId, {
        destination_id: destinationId || null,
        data_type: dataType,
        format,
        cron_expression: cron.trim() || null,
      });
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to create schedule");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)] space-y-3">
      <h4 className="text-sm font-semibold">New schedule</h4>
      {err && (
        <div className="p-2 bg-[var(--error-bg)] rounded text-xs text-[var(--error)]">{err}</div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">Destination</label>
          <select
            value={destinationId}
            onChange={(e) => setDestinationId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
          >
            {destinations.map((d) => (
              <option key={d.destination_id} value={d.destination_id}>
                {d.name} ({d.type})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">Data type</label>
          <select
            value={dataType}
            onChange={(e) => setDataType(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
          >
            {DATA_TYPES.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">Format</label>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
          >
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">Schedule</label>
          <select
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
          >
            {CRON_PRESETS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm hover:bg-[var(--bg-tertiary)] rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Calendar className="w-3.5 h-3.5" />}
          Create schedule
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Legacy GDPR export fallback
// ────────────────────────────────────────────────────────────────────

function LegacyExportFallback({ orgId }: { orgId: string }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function handleExport() {
    setLoading(true);
    setErr(null);
    setOk(false);
    try {
      await api.exportOrgData(orgId);
      setOk(true);
      setTimeout(() => setOk(false), 3000);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to export data");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
      <div className="flex items-center gap-2 mb-2">
        <FileArchive className="w-4 h-4 text-[var(--text-muted)]" />
        <h3 className="text-sm font-semibold">Legacy GDPR ZIP</h3>
      </div>
      <p className="text-xs text-[var(--text-secondary)] mb-3">
        One-shot ZIP of all org data (members, references, jobs, audit log, settings).
        Use the destinations above for incremental exports.
      </p>
      {err && (
        <div className="text-xs text-[var(--error)] mb-2">{err}</div>
      )}
      {ok && (
        <div className="text-xs text-[var(--success)] mb-2 flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" />
          Download started
        </div>
      )}
      <button
        onClick={handleExport}
        disabled={loading}
        className="px-3 py-1.5 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50"
      >
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
        Download ZIP
      </button>
    </div>
  );
}
