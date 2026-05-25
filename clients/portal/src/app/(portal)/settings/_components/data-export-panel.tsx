"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Download, Loader2, FileArchive, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface DataExportPanelProps {
  orgId: string;
  canExport: boolean;
}

export function DataExportPanel({ orgId, canExport }: DataExportPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      await api.exportOrgData(orgId);
      setSuccess(true);
      // Reset success state after 3 seconds
      setTimeout(() => setSuccess(false), 3000);
    } catch (e: any) {
      setError(e.message || "Failed to export data");
    } finally {
      setLoading(false);
    }
  };

  if (!canExport) return null;

  return (
    <div className="p-4 bg-[var(--surface)] rounded-xl border border-[var(--border)]">
      <div className="flex items-center gap-2 mb-4">
        <FileArchive className="w-4 h-4 text-[var(--text-muted)]" />
        <h3 className="text-sm font-semibold">Export Data</h3>
      </div>

      <p className="text-sm text-[var(--text-secondary)] mb-4">
        Download all organization data as a ZIP archive for GDPR compliance.
        The export includes members, code references, jobs, audit log, and settings.
      </p>

      {error && (
        <div className="text-sm text-red-500 p-2 bg-red-50 rounded mb-4">
          {error}
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 text-sm text-green-600 p-2 bg-green-50 rounded mb-4">
          <CheckCircle className="w-4 h-4" />
          Export downloaded successfully
        </div>
      )}

      <button
        onClick={handleExport}
        disabled={loading}
        className={cn(
          "px-4 py-2 text-sm rounded-lg flex items-center gap-2 transition-colors",
          "bg-[var(--accent)] text-white hover:opacity-90",
          loading && "opacity-50 cursor-not-allowed"
        )}
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Preparing export...
          </>
        ) : (
          <>
            <Download className="w-4 h-4" />
            Export All Data
          </>
        )}
      </button>

      <p className="text-xs text-[var(--text-muted)] mt-3">
        Export includes: members.json, references.json, jobs.json, audit_log.json, settings.json
      </p>
    </div>
  );
}