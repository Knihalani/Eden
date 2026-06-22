/** Phase 3 — Client-side upload panel (polished). */

"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Upload, FileArchive, Check, AlertCircle, Terminal, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { agentsApi, type AgentUpload } from "@/lib/api";
import { cn } from "@/lib/utils";

// P5: client-side file size cap. The backend rejects uploads > 50MB
// with a 413, but failing there means the user has already waited
// for the whole file to upload. We bail out at the drop / pick step
// with a clear inline error so the user knows immediately.
const MAX_BYTES = 50 * 1024 * 1024;

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

export function AgentUploadPanel({
  orgId,
  agentId,
  uploads,
}: {
  orgId: string;
  agentId: string;
  uploads: AgentUpload[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  async function onUpload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const resp = await agentsApi.upload(orgId, agentId, file, file.name);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      setSuccess(`Uploaded v${resp.upload_version} · ${resp.file_count} files`);
      router.refresh();
      setTimeout(() => setSuccess(null), 4000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function pickFile(f: File | undefined) {
    if (!f) {
      setFile(null);
      setError(null);
      return;
    }
    if (f.size > MAX_BYTES) {
      setFile(null);
      setError(
        `${f.name} is ${formatMb(f.size)}MB — uploads are capped at 50MB. Compress the archive or split the agent into smaller uploads.`,
      );
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setError(null);
    setFile(f);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    pickFile(e.dataTransfer.files?.[0]);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragging(true);
  }

  function onDragLeave() {
    setDragging(false);
  }

  return (
    <Card className="p-5">
      <header className="flex items-center gap-2 mb-3">
        <div className="p-1.5 rounded-md bg-[var(--accent-faint)] text-[var(--accent)]">
          <Upload className="w-3.5 h-3.5" />
        </div>
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
          Upload agent code
        </h2>
      </header>

      <p className="text-xs text-[var(--text-muted)] mb-4">
        Tar + upload a directory from the CLI:{" "}
        <code className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[11px] font-mono text-[var(--text-secondary)]">
          eden agent push &lt;dir&gt;
        </code>
        . Or drop a tarball/zip here (50MB max).
      </p>

      {/* Drop zone */}
      <label
        htmlFor="agent-upload-input"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={cn(
          "block cursor-pointer border-2 border-dashed rounded-lg p-6 text-center transition-colors",
          dragging
            ? "border-[var(--accent)] bg-[var(--accent-faint)]/30"
            : "border-[var(--border-default)] hover:border-[var(--accent)]/50 hover:bg-[var(--bg-secondary)]/30",
        )}
      >
        <input
          id="agent-upload-input"
          ref={inputRef}
          accept=".tar.gz,.tgz,.zip,application/gzip,application/zip,application/x-tar"
          className="sr-only"
          disabled={busy}
          onChange={(e) => pickFile(e.target.files?.[0])}
          type="file"
        />
        {file ? (
          <div className="flex items-center justify-center gap-3">
            <div className="p-2 rounded-md bg-[var(--accent-faint)] text-[var(--accent)]">
              <FileArchive className="w-5 h-5" />
            </div>
            <div className="text-left min-w-0 flex-1">
              <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                {file.name}
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                {(file.size / 1024).toFixed(1)} KB
              </p>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                setFile(null);
                if (inputRef.current) inputRef.current.value = "";
              }}
              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            <Upload className="w-6 h-6 mx-auto text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text-secondary)]">
              <span className="text-[var(--accent)] font-medium">Click to browse</span>{" "}
              or drag and drop
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              .tar.gz, .tgz, .zip — up to 50MB
            </p>
          </div>
        )}
      </label>

      {error && (
        <div className="mt-3 p-2.5 rounded-md border border-[var(--error)]/20 bg-[var(--error-bg)] flex items-start gap-2 text-xs text-[var(--error)]">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="mt-3 p-2.5 rounded-md border border-[var(--terminal)]/20 bg-[var(--terminal-faint)] flex items-center gap-2 text-xs text-[var(--terminal)]">
          <Check className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          disabled={!file || busy}
          onClick={onUpload}
        >
          {busy ? (
            <>
              <Terminal className="w-3.5 h-3.5 animate-pulse" />
              Uploading…
            </>
          ) : (
            <>
              <Upload className="w-3.5 h-3.5" />
              Upload
            </>
          )}
        </button>
        {uploads.length > 0 && (
          <p className="text-xs text-[var(--text-muted)]">
            Latest: v
            {Math.max(...uploads.map((u) => u.upload_version))}
          </p>
        )}
      </div>
    </Card>
  );
}
