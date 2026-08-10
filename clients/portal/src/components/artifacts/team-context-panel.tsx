"use client";

import { useRef } from "react";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { artifactsApi } from "@/lib/api/portal";
import { SHELL_QUERY } from "@/lib/portal-query";
import { useLabToast } from "@/lab/lab-toast";
import { formatRelativeTime } from "@/lib/format";

/** FEAT-148 — upload team .txt/.md context for Book/Ledger synthesis. */
export function TeamContextPanel({
  orgId,
  agentId,
  compact = false,
}: {
  orgId: string;
  agentId: string;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { pushToast } = useLabToast();

  const listQuery = useOrgQuery(
    queryKeys.artifacts.context(orgId, agentId),
    orgId,
    () => artifactsApi.listContext(orgId, agentId),
    { ...SHELL_QUERY, enabled: Boolean(orgId && agentId) },
  );
  const items = listQuery.data ?? [];

  const uploadMutation = useOrgMutation(
    (file: File) => artifactsApi.uploadContext(orgId, agentId, file),
    {
      invalidateKeys: [
        queryKeys.artifacts.all,
        queryKeys.artifacts.context(orgId, agentId),
      ],
      onSuccess: () => {
        pushToast({ title: "Context uploaded", tone: "ok" });
        if (inputRef.current) inputRef.current.value = "";
      },
      onError: (err) =>
        pushToast({
          title: "Upload failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        }),
    },
  );

  return (
    <section className={compact ? undefined : "mt-5 border-t border-[var(--line)] pt-5"}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="type-ui text-[var(--text-secondary)]">Team context</h3>
          {!compact ? (
            <p className="type-meta mt-1">
              Upload .txt or .md files the Book and Ledger fold into synthesis.
            </p>
          ) : (
            <p className="type-meta mt-0.5">.txt / .md into Book & Ledger</p>
          )}
        </div>
        <div>
          <input
            ref={inputRef}
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            className="sr-only"
            aria-label="Upload team context"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadMutation.mutate(file);
            }}
          />
          <button
            type="button"
            className="ds-btn ds-btn-secondary ds-btn-sm"
            disabled={uploadMutation.isPending}
            onClick={() => inputRef.current?.click()}
          >
            {uploadMutation.isPending ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>

      {listQuery.isLoading ? (
        <div
          className="mt-2 space-y-1.5"
          role="status"
          aria-label="Loading team context"
        >
          <div className="eden-skeleton-pulse h-3.5 w-1/3 rounded bg-[var(--line)]" />
          <div className="eden-skeleton-pulse h-3.5 w-2/5 rounded bg-[var(--line)]" />
          <div className="eden-skeleton-pulse h-3.5 w-1/2 rounded bg-[var(--line)]" />
        </div>
      ) : items.length === 0 ? (
        <p className="type-meta mt-2 text-[var(--text-faint)]">None yet.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.slice(0, compact ? 5 : 20).map((item) => (
            <li key={item.id} className={compact ? undefined : "ds-panel-muted p-3"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="type-ui truncate text-[var(--text)]">
                  {item.filename || "context"}
                </span>
                <span className="type-meta shrink-0">
                  {item.created_at ? formatRelativeTime(item.created_at) : `${item.size_bytes} B`}
                </span>
              </div>
              {!compact && item.content_preview ? (
                <p className="type-body mt-2 line-clamp-3 whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                  {item.content_preview}
                  {item.preview_truncated ? "…" : ""}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
