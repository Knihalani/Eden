"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Download, FileArchive, CheckCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setError(e.message || "Failed to export data");
    } finally {
      setLoading(false);
    }
  };

  if (!canExport) return null;

  return (
    <Card padding="md">
      <div className="flex items-center gap-2 mb-4">
        <FileArchive className="w-4 h-4 text-[var(--text-muted)]" />
        <h3 className="text-sm font-semibold">Export Data</h3>
      </div>

      <p className="text-sm text-[var(--text-secondary)] mb-4">
        Download all workspace data as a ZIP archive for GDPR compliance.
        The export includes members, code references, jobs, audit log, and settings.
      </p>

      {error && (
        <div className="text-sm text-[var(--error)] p-2 bg-[var(--error-dim)] rounded mb-4">
          {error}
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 text-sm text-[var(--terminal)] p-2 bg-[var(--terminal-faint)] rounded mb-4">
          <CheckCircle className="w-4 h-4" />
          Export downloaded successfully
        </div>
      )}

      <Button variant="default" className="min-h-11" onClick={handleExport} loading={loading}>
        <Download className="w-4 h-4" />
        {loading ? "Preparing export..." : "Export All Data"}
      </Button>

      <p className="text-xs text-[var(--text-muted)] mt-3">
        Export includes: members.json, references.json, jobs.json, audit_log.json, settings.json
      </p>
    </Card>
  );
}