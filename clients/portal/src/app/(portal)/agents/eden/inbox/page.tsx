"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check,
  GitPullRequestArrow,
  Inbox,
  MessageSquare,
  RefreshCw,
  X,
  FileCode,
  ChevronRight,
} from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useOrg } from "@/hooks/use-org";
import {
  codeChangeInboxApi,
  codeChangePolicyApi,
  type CodeChangeInboxPatch,
  type CodeChangePolicy,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { errorFromCaught } from "@/lib/safe-error-message";

const STATUS_FILTERS = [
  { id: "open", label: "Open" },
  { id: "approved", label: "Approved" },
  { id: "denied", label: "Denied" },
  { id: "needs_revision", label: "Needs revision" },
  { id: "merged", label: "Merged" },
] as const;

function relativeTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso).getTime();
    const diff = Math.floor((Date.now() - d) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return iso;
  }
}

function statusTone(status: string): string {
  const s = status.toLowerCase();
  if (s === "approved" || s === "merged") {
    return "border-[var(--terminal)]/30 text-[var(--terminal)] bg-[var(--terminal-faint)]";
  }
  if (s === "denied" || s === "reverted") {
    return "border-[var(--error)]/30 text-[var(--error)] bg-[var(--error)]/10";
  }
  if (s === "needs_revision") {
    return "border-[var(--warning)]/30 text-[var(--warning)] bg-[var(--warning)]/10";
  }
  return "border-[var(--border-default)] text-[var(--text-muted)] bg-[var(--bg-base)]";
}

export default function EdenPrInboxPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const orgId = currentOrg?.id ?? null;

  const [status, setStatus] = useState<string>("open");
  const [patches, setPatches] = useState<CodeChangeInboxPatch[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CodeChangeInboxPatch | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [policy, setPolicy] = useState<Partial<CodeChangePolicy>>({
    code_change_enabled: true,
  });
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadInbox = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [listRes, policyRes] = await Promise.all([
        codeChangeInboxApi.list(orgId, { status, sort: "priority" }),
        codeChangePolicyApi.get(orgId).catch(() => null),
      ]);
      const rows = listRes.data?.patches ?? [];
      setPatches(rows);
      if (policyRes?.data?.policy) {
        setPolicy(policyRes.data.policy);
      }
      if (rows.length > 0) {
        const stillVisible = selectedId && rows.some((p) => p.patch_id === selectedId);
        if (!stillVisible) {
          setSelectedId(rows[0].patch_id);
        }
      } else {
        setSelectedId(null);
        setDetail(null);
        setDiff("");
      }
    } catch (err) {
      setError(errorFromCaught(err, "Failed to load PR inbox"));
    } finally {
      setLoading(false);
    }
  }, [orgId, status, selectedId]);

  useEffect(() => {
    void loadInbox();
    // Only re-fetch when org/status changes — not when selectedId flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, status]);

  const loadDetail = useCallback(
    async (patchId: string) => {
      if (!orgId) return;
      setDetailLoading(true);
      try {
        const [patchRes, diffRes] = await Promise.all([
          codeChangeInboxApi.get(orgId, patchId),
          codeChangeInboxApi.diff(orgId, patchId),
        ]);
        setDetail(patchRes.data ?? null);
        setDiff(diffRes.data?.diff ?? "");
        setComment("");
      } catch (err) {
        toast.error(errorFromCaught(err, "Failed to load patch"));
      } finally {
        setDetailLoading(false);
      }
    },
    [orgId, toast],
  );

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const runAction = async (
    action: "approve" | "deny" | "comment" | "open-pr",
  ) => {
    if (!orgId || !selectedId) return;
    setActing(action);
    try {
      if (action === "open-pr") {
        const res = await codeChangeInboxApi.openPR(orgId, selectedId, {
          code_change_enabled: Boolean(policy.code_change_enabled),
        });
        if (res.status !== "ok") {
          throw new Error(res.message || "Open PR failed");
        }
        toast.success("PR open requested");
      } else {
        const res = await codeChangeInboxApi.act(orgId, selectedId, action, {
          comment,
          policy: {
            code_change_enabled: Boolean(policy.code_change_enabled),
          },
        });
        if (res.status !== "ok") {
          throw new Error(res.message || `${action} failed`);
        }
        toast.success(
          action === "approve"
            ? "Patch approved"
            : action === "deny"
              ? "Patch denied"
              : "Comment saved",
        );
      }
      await loadInbox();
      if (selectedId) await loadDetail(selectedId);
    } catch (err) {
      toast.error(errorFromCaught(err, "Action failed"));
    } finally {
      setActing(null);
    }
  };

  const selected = useMemo(
    () => patches.find((p) => p.patch_id === selectedId) ?? null,
    [patches, selectedId],
  );

  if (!orgId) {
    return (
      <PageContent>
        <NoOrgState />
      </PageContent>
    );
  }

  return (
    <PageContent>
      <PageHeader
        title="PR Inbox"
        subtitle="Review Eden-proposed patches — approve, deny, comment, or open a PR."
        icon={Inbox}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" asChild>
              <Link href="/pr-suggestions">PR Suggestions</Link>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void loadInbox()}
              disabled={loading}
              aria-label="Refresh inbox"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        }
      />

      <div className="mt-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setStatus(f.id)}
            className={cn(
              "px-3 py-1 text-xs font-mono uppercase tracking-wider border transition-colors",
              status === f.id
                ? "border-[var(--terminal)]/40 text-[var(--terminal)] bg-[var(--terminal-faint)]"
                : "border-[var(--border-default)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="mt-6">
          <ErrorState
            title="Could not load PR inbox"
            message={error}
            action={
              <Button onClick={() => void loadInbox()} variant="outline" size="sm">
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Try again
              </Button>
            }
          />
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-[minmax(280px,360px)_1fr] gap-4 min-h-[60vh]">
          {/* List */}
          <div className="border border-[var(--border-default)] bg-[var(--bg-primary)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--border-default)] bg-[var(--bg-base)]">
              <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">
                patches · {patches.length}
              </span>
            </div>
            <div className="max-h-[70vh] overflow-y-auto">
              {loading && patches.length === 0 ? (
                <div className="p-3 space-y-2">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : patches.length === 0 ? (
                <EmptyState
                  icon={Inbox}
                  title="No patches in this view"
                  description="When Eden proposes a code fix, it lands here for review."
                  size="sm"
                />
              ) : (
                <ul className="divide-y divide-[var(--border-subtle)]">
                  {patches.map((p) => {
                    const active = p.patch_id === selectedId;
                    return (
                      <li key={p.patch_id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(p.patch_id)}
                          className={cn(
                            "w-full text-left px-3 py-3 transition-colors",
                            active
                              ? "bg-[var(--accent-faint)] border-l-2 border-l-[var(--accent)]"
                              : "hover:bg-[var(--bg-tertiary)] border-l-2 border-l-transparent",
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm text-[var(--text-primary)] line-clamp-2">
                                {p.description || p.patch_id}
                              </p>
                              <p className="mt-1 text-[10px] font-mono text-[var(--text-muted)] truncate">
                                {p.repo_id} · {p.patch_id.slice(0, 12)}
                              </p>
                            </div>
                            <ChevronRight
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 mt-1",
                                active
                                  ? "text-[var(--accent)]"
                                  : "text-[var(--text-muted)]",
                              )}
                            />
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={cn("text-[10px]", statusTone(p.status))}
                            >
                              {p.status}
                            </Badge>
                            <span className="text-[10px] text-[var(--text-muted)]">
                              {relativeTime(p.created_at)}
                            </span>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Detail */}
          <div className="border border-[var(--border-default)] bg-[var(--bg-primary)] min-h-[420px]">
            {!selectedId ? (
              <div className="h-full flex items-center justify-center p-8">
                <EmptyState
                  icon={FileCode}
                  title="Select a patch"
                  description="Choose a proposed patch from the list to review the diff."
                  size="sm"
                />
              </div>
            ) : detailLoading && !detail ? (
              <div className="p-5 space-y-3">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-48 w-full" />
              </div>
            ) : (
              <AnimatePresence mode="wait">
                <motion.div
                  key={selectedId}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18 }}
                  className="flex flex-col h-full"
                >
                  <div className="px-5 py-4 border-b border-[var(--border-default)] bg-[var(--bg-base)]">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="text-base text-[var(--text-primary)] font-medium">
                          {detail?.description || selected?.description || selectedId}
                        </h2>
                        <p className="mt-1 text-xs font-mono text-[var(--text-muted)]">
                          {detail?.repo_id || selected?.repo_id} ·{" "}
                          {detail?.patch_id || selectedId}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          statusTone(detail?.status || selected?.status || "proposed"),
                        )}
                      >
                        {detail?.status || selected?.status}
                      </Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-4 text-xs text-[var(--text-muted)]">
                      <span>
                        quality{" "}
                        <span className="text-[var(--text-secondary)] font-mono">
                          {detail?.quality_score != null
                            ? Number(detail.quality_score).toFixed(2)
                            : "—"}
                        </span>
                      </span>
                      <span>
                        blast{" "}
                        <span className="text-[var(--text-secondary)] font-mono">
                          {detail?.blast_radius_score != null
                            ? Number(detail.blast_radius_score).toFixed(2)
                            : "—"}
                        </span>
                      </span>
                      {detail?.rca_id && (
                        <span className="font-mono truncate max-w-[180px]">
                          rca {detail.rca_id}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="px-5 py-4 flex-1 overflow-y-auto space-y-4">
                    {detail?.explanation?.what_happened && (
                      <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                        {detail.explanation.what_happened}
                      </p>
                    )}
                    <div>
                      <div className="mb-2 text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">
                        unified diff
                      </div>
                      {diff ? (
                        <CodeBlock code={diff} language="diff" filename="patch.diff" />
                      ) : (
                        <div className="border border-[var(--border-default)] bg-[var(--bg-base)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                          No diff available for this patch.
                        </div>
                      )}
                    </div>

                    <div>
                      <label
                        htmlFor="inbox-comment"
                        className="mb-2 block text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]"
                      >
                        comment
                      </label>
                      <Textarea
                        id="inbox-comment"
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder="Optional review note…"
                        className="min-h-[72px] bg-[var(--bg-base)] border-[var(--border-default)] font-mono text-sm"
                      />
                    </div>
                  </div>

                  <div className="px-5 py-3 border-t border-[var(--border-default)] bg-[var(--bg-base)] flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => void runAction("approve")}
                      disabled={!!acting}
                    >
                      <Check className="h-3.5 w-3.5 mr-1.5" />
                      {acting === "approve" ? "Approving…" : "Approve"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void runAction("deny")}
                      disabled={!!acting}
                    >
                      <X className="h-3.5 w-3.5 mr-1.5" />
                      {acting === "deny" ? "Denying…" : "Deny"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void runAction("comment")}
                      disabled={!!acting || !comment.trim()}
                    >
                      <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                      {acting === "comment" ? "Saving…" : "Comment"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void runAction("open-pr")}
                      disabled={!!acting}
                      className="ml-auto"
                    >
                      <GitPullRequestArrow className="h-3.5 w-3.5 mr-1.5" />
                      {acting === "open-pr" ? "Opening…" : "Open PR"}
                    </Button>
                  </div>
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        </div>
      )}
    </PageContent>
  );
}
