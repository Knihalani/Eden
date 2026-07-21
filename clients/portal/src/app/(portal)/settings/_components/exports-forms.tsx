"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import {
  Download,
  Loader2,
  Database,
  Calendar,
  FileArchive,
  CheckCircle2,
} from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";

// Catalog must match eden.api.routes.export_destinations.DATA_TYPES / FORMATS.
export const EXPORT_DATA_TYPES = [
  { id: "traces", label: "Traces", description: "OpenTelemetry trace spans (telemetry_events)" },
  { id: "judge_scores", label: "Judge scores", description: "LLM-as-judge scores per trace" },
  {
    id: "audit_log",
    label: "Audit trail",
    description: "Workspace audit trail rows (API id: audit_log)",
  },
  { id: "usage_events", label: "Usage events", description: "Per-tenant usage metering" },
  { id: "insights", label: "Insights", description: "Detector-generated insights" },
  { id: "telemetry_events", label: "Telemetry events", description: "Raw telemetry rows" },
] as const;

export const EXPORT_FORMATS = [
  { id: "csv", label: "CSV" },
  { id: "parquet", label: "Parquet" },
  { id: "jsonl", label: "JSONL" },
] as const;

export const EXPORT_DESTINATION_TYPES = [
  { id: "s3", label: "Amazon S3" },
  { id: "gcs", label: "Google Cloud Storage" },
] as const;

export const EXPORT_CRON_PRESETS = [
  { id: "", label: "One-shot (no schedule)" },
  { id: "0 0 * * *", label: "Daily at midnight UTC" },
  { id: "0 0 * * 0", label: "Weekly on Sunday" },
  { id: "0 0 1 * *", label: "Monthly on the 1st" },
] as const;

export function DestinationForm({
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
    <Panel tone="inset" padding="md" className="mb-space-4 space-y-space-3">
      <h4 className="text-sm font-semibold">New destination</h4>
      {err && (
        <div className="p-2 bg-[var(--error-bg)] rounded text-xs text-[var(--error)]">{err}</div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Destination name (e.g. 'prod-archive')"
          aria-label="Destination name"
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as "s3" | "gcs")}
          aria-label="Destination type"
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
        >
          {EXPORT_DESTINATION_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder="Bucket name"
          aria-label="Bucket name"
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm font-mono"
        />
        <input
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          placeholder="Region (optional, e.g. us-east-1)"
          aria-label="Region"
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm"
        />
        <input
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
          placeholder={type === "s3" ? "Access key ID" : "Service account email"}
          aria-label={type === "s3" ? "Access key ID" : "Service account email"}
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm font-mono"
        />
        <input
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
          placeholder={type === "s3" ? "Secret access key" : "Private key (PEM)"}
          aria-label={type === "s3" ? "Secret access key" : "Private key"}
          type="password"
          className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-sm font-mono"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="default"
          className="min-h-11"
          onClick={handleSave}
          disabled={!name.trim() || !bucket.trim()}
          loading={saving}
        >
          <Database className="w-3.5 h-3.5" />
          Save destination
        </Button>
      </div>
    </Panel>
  );
}

export function ScheduleForm({
  orgId,
  destinations,
  onSaved,
  onCancel,
}: {
  orgId: string;
  destinations: Array<{ destination_id: string; name: string; type: string }>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [destinationId, setDestinationId] = useState(destinations[0]?.destination_id || "");
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
    <Panel tone="inset" padding="md" className="mb-space-4 space-y-space-3">
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
            {EXPORT_DATA_TYPES.map((d) => (
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
            {EXPORT_FORMATS.map((f) => (
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
            {EXPORT_CRON_PRESETS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="default" className="min-h-11" onClick={handleSave} loading={saving}>
          <Calendar className="w-3.5 h-3.5" />
          Create schedule
        </Button>
      </div>
    </Panel>
  );
}

export function LegacyExportFallback({ orgId }: { orgId: string }) {
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
    <Panel tone="inset" padding="md">
      <div className="flex items-center gap-space-2 mb-space-2">
        <FileArchive className="w-4 h-4 text-[var(--text-muted)]" />
        <h3 className="text-sm font-semibold">Legacy GDPR ZIP</h3>
      </div>
      <p className="text-xs text-[var(--text-secondary)] mb-space-3">
        One-shot ZIP of all workspace data (members, references, jobs, audit trail, settings).
        Use the destinations above for incremental exports.
      </p>
      {err && <div className="text-xs text-[var(--error)] mb-2">{err}</div>}
      {ok && (
        <div className="text-xs text-[var(--success)] mb-2 flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" />
          Download started
        </div>
      )}
      <Button type="button" variant="secondary" onClick={handleExport} disabled={loading} loading={loading}>
        {!loading && <Download className="w-3.5 h-3.5" />}
        Download ZIP
      </Button>
    </Panel>
  );
}
