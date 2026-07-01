"use client";

import { useEffect, useState, useCallback, use, useMemo } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitPullRequestArrow,
  RefreshCw,
  ArrowLeft,
  Sparkles,
  TrendingUp,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
  GitPullRequest,
  FileCode,
  Send,
  Copy,
  Check,
  X,
  Columns2,
  Rows3,
  ExternalLink,
  RotateCcw,
  AlertTriangle,
  History } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { prSuggestionApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { StatCard } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { PRStatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/components/ui/empty-state";
import type {
  PRSuggestion,
  PRSuggestionStatus,
  PRSuggestionTrigger } from "@/lib/types";

// ── Constants + helpers (mirror the inbox) ──────────────────────

const TRIGGER_LABELS: Record<PRSuggestionTrigger, string> = {
  rca_cluster: "RCA cluster",
  drift_alert: "Drift alert",
  retrieval_gap: "Retrieval gap",
  judge_regression: "Judge regression" };

const TRIGGER_COLORS: Record<PRSuggestionTrigger, string> = {
  rca_cluster: "bg-[var(--error)]/10 text-[var(--error)] border-[var(--error)]/20",
  drift_alert: "bg-[var(--warning)]/10 text-[var(--warning)] border-[var(--warning)]/20",
  retrieval_gap: "bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20",
  judge_regression: "bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20" };

const __STATUS_ICONS: Record<
  PRSuggestionStatus,
  React.ComponentType<{ className?: string }>
> = {
  pending: Clock,
  opened: GitPullRequestArrow,
  merged: CheckCircle2,
  rejected: XCircle };

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function relativeTime(iso: string): string {
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

// ── Diff parser ────────────────────────────────────────────────

interface DiffLine {
  type: "context" | "add" | "remove" | "header" | "meta";
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

function parseDiff(diff: string): DiffHunk[] {
  if (!diff.trim()) return [];
  const lines = diff.split("\n");
  const hunks: DiffHunk[] = [];
  let i = 0;
  let oldLineNum = 0;
  let newLineNum = 0;
  // Skip "--- a/file" / "+++ b/file" headers.
  while (i < lines.length && lines[i].startsWith("---")) i++;
  while (i < lines.length && lines[i].startsWith("+++")) i++;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("@@")) {
      i++;
      continue;
    }
    // Parse "@@ -oldStart,oldLines +newStart,newLines @@"
    const m = line.match(
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/
    );
    if (!m) {
      i++;
      continue;
    }
    oldLineNum = parseInt(m[1], 10);
    const oldCount = m[2] ? parseInt(m[2], 10) : 1;
    newLineNum = parseInt(m[3], 10);
    const newCount = m[4] ? parseInt(m[4], 10) : 1;
    i++;
    const diffLines: DiffLine[] = [];
    let o = oldLineNum;
    let n = newLineNum;
    let oCount = 0;
    let nCount = 0;
    while (i < lines.length && (oCount < oldCount || nCount < newCount)) {
      const l = lines[i];
      if (l.startsWith("@@") || l.startsWith("---") || l.startsWith("+++")) {
        break;
      }
      if (l.startsWith("+")) {
        diffLines.push({
          type: "add",
          oldLine: null,
          newLine: n,
          content: l.slice(1) });
        n++;
        nCount++;
      } else if (l.startsWith("-")) {
        diffLines.push({
          type: "remove",
          oldLine: o,
          newLine: null,
          content: l.slice(1) });
        o++;
        oCount++;
      } else if (l.startsWith(" ") || l === "") {
        diffLines.push({
          type: "context",
          oldLine: o,
          newLine: n,
          content: l.startsWith(" ") ? l.slice(1) : "" });
        o++;
        n++;
        oCount++;
        nCount++;
      } else {
        // Unrecognized line — skip.
        i++;
        continue;
      }
      i++;
    }
    hunks.push({
      oldStart: oldLineNum,
      oldLines: oldCount,
      newStart: newLineNum,
      newLines: newCount,
      header: line,
      lines: diffLines });
  }
  return hunks;
}

// Split a diff into per-line pairs for the "split" view
// (left = old, right = new).
function pairDiffLines(
  hunk: DiffHunk,
): Array<{
  left: DiffLine | null;
  right: DiffLine | null;
}> {
  const pairs: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  const queue: DiffLine[] = [...hunk.lines];
  while (queue.length > 0) {
    const l = queue[0];
    if (l.type === "context") {
      pairs.push({ left: l, right: l });
      queue.shift();
    } else if (l.type === "remove") {
      const next = queue[1];
      if (next && next.type === "add") {
        pairs.push({ left: l, right: next });
        queue.shift();
        queue.shift();
      } else {
        pairs.push({ left: l, right: null });
        queue.shift();
      }
    } else if (l.type === "add") {
      const next = queue[1];
      if (next && next.type === "remove") {
        pairs.push({ left: next, right: l });
        queue.shift();
        queue.shift();
      } else {
        pairs.push({ left: null, right: l });
        queue.shift();
      }
    } else {
      queue.shift();
    }
  }
  return pairs;
}

// Word-level diff highlighting: split a string into a
// list of (text, isChanged) tuples. We use a simple
// tokeniser (whitespace + punctuation) — good enough
// for code review.
function tokenise(s: string): string[] {
  return s.split(/(\s+|[^\w\s])/).filter(Boolean);
}

function wordDiff(
  left: string,
  right: string,
): { left: Array<{ text: string; changed: boolean }>; right: Array<{ text: string; changed: boolean }> } {
  const lTokens = tokenise(left);
  const rTokens = tokenise(right);
  const lSet = new Set(lTokens);
  const rSet = new Set(rTokens);
  return {
    left: lTokens.map((t) => ({ text: t, changed: !rSet.has(t) })),
    right: rTokens.map((t) => ({ text: t, changed: !lSet.has(t) })) };
}

// ── DiffViewer (unified + split) ─────────────────────────────────

function DiffViewer({
  diff,
  diffMode,
  onModeChange }: {
  diff: string;
  diffMode: "unified" | "split";
  onModeChange: (m: "unified" | "split") => void;
}) {
  const hunks = useMemo(() => parseDiff(diff), [diff]);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  if (hunks.length === 0) {
    return (
      <div className="text-sm text-[var(--text-muted)] italic p-6 bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg text-center">
        No diff generated. Configure an LLM client on the
        PRSuggester backend to generate a real unified
        diff, or write the change by hand and re-run the
        open-PR flow.
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar: diff-mode toggle + copy button */}
      <div className="flex items-center justify-between mb-2">
        <div className="inline-flex bg-[var(--bg-base)] border border-[var(--border-default)] rounded-md p-0.5">
          <button
            onClick={() => onModeChange("unified")}
            className={cn(
              "px-2.5 py-1 text-xs rounded flex items-center gap-1.5",
              diffMode === "unified"
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-muted)]",
            )}
          >
            <Rows3 className="h-3 w-3" />
            Unified
          </button>
          <button
            onClick={() => onModeChange("split")}
            className={cn(
              "px-2.5 py-1 text-xs rounded flex items-center gap-1.5",
              diffMode === "split"
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-muted)]",
            )}
          >
            <Columns2 className="h-3 w-3" />
            Split
          </button>
        </div>
        <Button variant="ghost" size="sm" onClick={handleCopy} aria-label={copied ? "Copied diff to clipboard" : "Copy diff to clipboard"}>
          {copied ? (
            <Check className="h-4 w-4 text-[var(--terminal)]" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* The diff itself */}
      <div className="text-xs font-mono leading-relaxed bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg overflow-hidden">
        {hunks.map((h, hi) => (
          <div key={hi} className="border-b border-[var(--border-default)]/50 last:border-0">
            <div className="px-3 py-1 bg-[var(--accent)]/5 text-[var(--accent)] text-[10px]">
              {h.header}
            </div>
            {diffMode === "unified" ? (
              <UnifiedHunk hunk={h} />
            ) : (
              <SplitHunk hunk={h} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function UnifiedHunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <div>
      {hunk.lines.map((l, i) => {
        const cls = cn(
          "flex px-3 py-0.5",
          l.type === "add" && "bg-[var(--terminal)]/5 text-[var(--terminal)]",
          l.type === "remove" && "bg-[var(--error)]/5 text-[var(--error)]",
          l.type === "context" && "text-[var(--text-muted)]",
        );
        const prefix = l.type === "add" ? "+" : l.type === "remove" ? "-" : " ";
        const lineNum =
          l.type === "remove"
            ? l.oldLine
            : l.type === "add"
            ? l.newLine
            : l.newLine;
        return (
          <div key={i} className={cls}>
            <span className="text-[var(--text-secondary)] select-none w-8 text-right pr-2">
              {lineNum ?? ""}
            </span>
            <span className="select-none w-3 text-[var(--text-secondary)]">{prefix}</span>
            <span className="flex-1 whitespace-pre-wrap break-all">
              {l.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SplitHunk({ hunk }: { hunk: DiffHunk }) {
  const pairs = pairDiffLines(hunk);
  return (
    <div>
      {pairs.map((p, i) => {
        // Word-level diff for paired remove+add lines.
        let left: React.ReactNode = null;
        let right: React.ReactNode = null;
        if (p.left && p.right && p.left.type === "remove" && p.right.type === "add") {
          const wd = wordDiff(p.left.content, p.right.content);
          left = (
            <span>
              {wd.left.map((tok, ti) => (
                <span
                  key={ti}
                  className={cn(
                    tok.changed && "bg-[var(--error)]/20 rounded-sm",
                  )}
                >
                  {tok.text}
                </span>
              ))}
            </span>
          );
          right = (
            <span>
              {wd.right.map((tok, ti) => (
                <span
                  key={ti}
                  className={cn(
                    tok.changed && "bg-[var(--terminal)]/20 rounded-sm",
                  )}
                >
                  {tok.text}
                </span>
              ))}
            </span>
          );
        } else {
          left = p.left ? <span>{p.left.content}</span> : null;
          right = p.right ? <span>{p.right.content}</span> : null;
        }
        return (
          <div key={i} className="grid grid-cols-2 divide-x divide-[var(--border-default)]/50">
            <div
              className={cn(
                "flex px-3 py-0.5",
                p.left?.type === "remove" && "bg-[var(--error)]/5 text-[var(--error)]",
                p.left?.type === "context" && "text-[var(--text-muted)]",
                !p.left && "bg-[var(--bg-base)]/30",
              )}
            >
              <span className="text-[var(--text-secondary)] select-none w-8 text-right pr-2">
                {p.left?.oldLine ?? ""}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-all">
                {left}
              </span>
            </div>
            <div
              className={cn(
                "flex px-3 py-0.5",
                p.right?.type === "add" && "bg-[var(--terminal)]/5 text-[var(--terminal)]",
                p.right?.type === "context" && "text-[var(--text-muted)]",
                !p.right && "bg-[var(--bg-base)]/30",
              )}
            >
              <span className="text-[var(--text-secondary)] select-none w-8 text-right pr-2">
                {p.right?.newLine ?? ""}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-all">
                {right}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── FileViewer (loads from the backend file endpoint) ──────────

function FileViewer({ path, orgId, suggestionId }: { path: string; orgId: string; suggestionId: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    prSuggestionApi
      .getFile(orgId, suggestionId, path)
      .then((res) => {
        if (!mounted) return;
        if (res.status === "ok") {
          setContent(res.data.content);
          setError("");
        } else {
          setError("File not accessible.");
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setError(
          err instanceof Error ? err.message : "Failed to read file"
        );
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [orgId, suggestionId, path]);

  return (
    <div className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 border-b border-[var(--border-default)] bg-[var(--bg-base)] flex items-center gap-2">
        <FileCode className="h-3 w-3 text-[var(--text-muted)]" />
        <span className="text-xs font-mono text-[var(--text-muted)]">{path}</span>
      </div>
      {loading ? (
        <div className="p-3 text-xs text-[var(--text-muted)] flex items-center gap-2">
          <RefreshCw className="h-3 w-3 animate-spin" />
          Reading file…
        </div>
      ) : error ? (
        <div className="p-3 text-xs text-[var(--error)] flex items-center gap-2">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      ) : (
        <pre className="text-xs font-mono text-[var(--text-muted)] p-3 max-h-96 overflow-auto leading-relaxed">
          {content || "(empty)"}
        </pre>
      )}
    </div>
  );
}

// ── Confirm dialog (for destructive actions) ───────────────────

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  variant,
  busy,
  onConfirm,
  onCancel }: {
  title: string;
  description: string;
  confirmLabel: string;
  variant: "danger" | "primary";
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-[var(--bg-base)]/70 z-50 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 10 }}
        className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg w-full max-w-md p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle
            className={cn(
              "h-5 w-5 mt-0.5 flex-shrink-0",
              variant === "danger" ? "text-[var(--error)]" : "text-[var(--accent)]",
            )}
          />
          <div className="flex-1">
            <h3 className="text-base font-semibold text-[var(--text-primary)]">
              {title}
            </h3>
            <p className="text-sm text-[var(--text-muted)] mt-1">{description}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              variant === "danger" &&
                "bg-[var(--error)] hover:bg-[var(--error)]/600 text-[var(--bg-primary)]",
            )}
          >
            {busy && <RefreshCw className="h-4 w-4 animate-spin mr-1" />}
            {confirmLabel}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Open-PR dialog (extracted) ────────────────────────────────

function OpenPRDialog({
  suggestion,
  onClose,
  onOpened }: {
  suggestion: PRSuggestion;
  onClose: () => void;
  onOpened: (prNumber: number, url: string) => void;
}) {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [prTitle, setPrTitle] = useState(suggestion.pr_title);
  const [prBody, setPrBody] = useState(suggestion.pr_body);
  const [branch, setBranch] = useState(
    `eden/auto-${suggestion.id.replace(/^prsug_/, "")}`,
  );
  const [base, setBase] = useState("main");
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    if (!currentOrg) return;
    setBusy(true);
    try {
      const data = await prSuggestionApi.openPR(currentOrg.id, suggestion.id, {
        pr_title: prTitle,
        pr_body: prBody,
        branch,
        base });
      onOpened(data.data.pr.number, data.data.pr.url);
      toast.success(`PR #${data.data.pr.number} opened`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open PR");
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-[var(--bg-base)]/70 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 10 }}
        className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg w-full max-w-xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <GitPullRequest className="h-4 w-4 text-[var(--accent)]" />
            Open PR
          </h3>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close open PR dialog">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div>
          <label className="text-xs text-[var(--text-muted)] mb-1 block">Title</label>
          <input
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            aria-label="PR title"
            className="w-full bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-sm text-[var(--text-primary)]"
          />
        </div>
        <div>
          <label className="text-xs text-[var(--text-muted)] mb-1 block">Body</label>
          <textarea
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            aria-label="PR body"
            className="w-full h-32 bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-sm text-[var(--text-primary)] font-mono"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-[var(--text-muted)] mb-1 block">Branch</label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              aria-label="Branch name"
              className="w-full bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-xs font-mono text-[var(--text-primary)]"
            />
          </div>
          <div>
            <label className="text-xs text-[var(--text-muted)] mb-1 block">Base</label>
            <input
              value={base}
              onChange={(e) => setBase(e.target.value)}
              aria-label="Base branch"
              className="w-full bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-xs font-mono text-[var(--text-primary)]"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={busy}>
            {busy && <RefreshCw className="h-4 w-4 animate-spin mr-1" />}
            <Send className="h-4 w-4 mr-1" />
            Open PR
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Main page ─────────────────────────────────────────────────

export default function PRSuggestionDetailPage({
  params }: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [suggestion, setSuggestion] = useState<PRSuggestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showOpenPR, setShowOpenPR] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prNumber, setPrNumber] = useState<number | null>(null);
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    "merged" | "rejected" | "regenerate" | null
  >(null);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError("");
    try {
      const data = await prSuggestionApi.get(currentOrg.id, id);
      setSuggestion(data.data.suggestion);
      if (data.data.suggestion.opened_pr_number !== null) {
        setPrNumber(data.data.suggestion.opened_pr_number);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load suggestion"
      );
    } finally {
      setLoading(false);
    }
  }, [currentOrg, id]);

  useEffect(() => {
     
    load();
  }, [load]);

  async function handleRegenerate() {
    if (!currentOrg) return;
    setBusyAction("regenerate");
    try {
      const data = await prSuggestionApi.regenerate(currentOrg.id, id);
      setSuggestion(data.data.suggestion);
      setConfirmAction(null);
      toast.success("Suggestion regenerated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Regenerate failed");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleStatusChange(status: "merged" | "rejected" | "opened") {
    if (!currentOrg) return;
    setBusyAction(status);
    try {
      const data = await prSuggestionApi.updateStatus(
        currentOrg.id, id, status,
      );
      setSuggestion(data.data.suggestion);
      setConfirmAction(null);
      toast.success(`Status updated to ${status}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCopyAsMarkdown() {
    if (!suggestion) return;
    const md = [
      `## ${suggestion.pr_title}`,
      "",
      suggestion.pr_body,
      "",
      "### Proposed diff",
      "",
      "```diff",
      suggestion.patch_diff || "(no diff)",
      "```",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(md);
      toast.success("Copied as markdown");
    } catch {
      toast.error("Clipboard access denied");
    }
  }

  if (!currentOrg) {
    return (
      <div className="p-6">
        <EmptyState
          icon={History}
          title="No organization"
          description="Select an organization to view PR suggestions."
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="p-6 text-center py-12 text-[var(--text-muted)]"
      >
        <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
        Loading…
      </div>
    );
  }

  if (error || !suggestion) {
    return (
      <div className="p-6">
        <Button
          variant="ghost"
          onClick={() => router.push("/pr-suggestions")}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <Card className="border-[var(--error)]/20 bg-[var(--error)]/5">
          <div
            role="alert"
            className="p-4 text-sm text-[var(--error)] flex items-center justify-between gap-2"
          >
            <span className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {error || "Suggestion not found."}
            </span>
            <button
              onClick={load}
              disabled={loading}
              className="text-xs font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        </Card>
      </div>
    );
  }

  const isPending = suggestion.status === "pending";
  const isOpened = suggestion.status === "opened";

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 page-enter">
      {/* Back button */}
      <Button
        variant="ghost"
        onClick={() => router.push("/pr-suggestions")}
        size="sm"
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        Back to inbox
      </Button>

      {/* Header */}
      <PageHeader
        eyebrow="Optimize"
        title={suggestion.pr_title || "PR suggestion"}
        subtitle={suggestion.trigger_summary}
        icon={GitPullRequest}
        actions={
          <div className="flex flex-col gap-2">
            {isPending && (
              <>
                <Button onClick={() => setShowOpenPR(true)}>
                  <Send className="h-4 w-4 mr-1" />
                  Open PR
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmAction("regenerate")}
                  disabled={busyAction === "regenerate"}
                >
                  {busyAction === "regenerate" ? (
                    <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4 mr-1" />
                  )}
                  Regenerate
                </Button>
              </>
            )}
            {prUrl && (
              <a href={prUrl} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm">
                  <ExternalLink className="h-4 w-4 mr-1" />
                  View PR #{prNumber}
                </Button>
              </a>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyAsMarkdown}
            >
              <Copy className="h-4 w-4 mr-1" />
              Copy as markdown
            </Button>
          </div>
        }
      />
      <div className="flex items-center gap-2 mb-6 flex-wrap -mt-4">
        <Badge
          variant="outline"
          className={cn("text-xs", TRIGGER_COLORS[suggestion.trigger])}
        >
          <Sparkles className="h-3 w-3 mr-1" />
          {TRIGGER_LABELS[suggestion.trigger]}
        </Badge>
        <PRStatusBadge status={suggestion.status} />
        <span className="text-xs text-[var(--text-muted)]">
          ID: <span className="font-mono">{suggestion.id}</span>
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          • {relativeTime(suggestion.created_at)}
        </span>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Confidence"
          value={`${Math.round(suggestion.confidence * 100)}%`}
          icon={TrendingUp}
        />
        <StatCard
          title="Blast radius"
          value={suggestion.blast_radius.toFixed(2)}
          icon={Sparkles}
        />
        <StatCard
          title="Trigger"
          value={TRIGGER_LABELS[suggestion.trigger]}
          icon={AlertCircle}
        />
        <StatCard
          title="Created"
          value={formatDate(suggestion.created_at)}
          icon={Clock}
        />
      </div>

      {/* Status-transition bar (visible for opened / merged / rejected) */}
      {(isOpened || suggestion.status === "merged" || suggestion.status === "rejected") && (
        <Card className="border-[var(--border-default)] bg-[var(--bg-base)]">
          <div className="p-3 flex items-center justify-between gap-2">
            <div className="text-sm text-[var(--text-muted)]">
              {suggestion.status === "merged" &&
                "This suggestion has been merged."}
              {isOpened &&
                "A PR is open for this suggestion. Mark it as merged or rejected when you know the outcome."}
              {suggestion.status === "rejected" &&
                "This suggestion was rejected. Reopen it to send it back to the inbox."}
            </div>
            <div className="flex gap-2">
              {isOpened && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmAction("merged")}
                    disabled={busyAction === "merged"}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1" />
                    Mark merged
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmAction("rejected")}
                    disabled={busyAction === "rejected"}
                  >
                    <XCircle className="h-4 w-4 mr-1" />
                    Reject
                  </Button>
                </>
              )}
              {suggestion.status === "rejected" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStatusChange("opened")}
                  disabled={busyAction === "opened"}
                >
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Reopen
                </Button>
              )}
              {suggestion.status === "merged" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStatusChange("opened")}
                  disabled={busyAction === "opened"}
                >
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Reopen
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Diff + file panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-muted)]">
            Proposed diff
          </h2>
          <DiffViewer
            diff={suggestion.patch_diff}
            diffMode={diffMode}
            onModeChange={setDiffMode}
          />
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-muted)]">
            Affected files ({suggestion.files.length})
          </h2>
          {suggestion.files.length === 0 ? (
            <div className="text-sm text-[var(--text-muted)] italic p-3 bg-[var(--bg-base)] border border-[var(--border-default)] rounded">
              No files attached.
            </div>
          ) : (
            <div className="space-y-1">
              {suggestion.files.map((f) => (
                <button
                  key={f.path}
                  onClick={() =>
                    setSelectedFile(
                      selectedFile === f.path ? null : f.path
                    )
                  }
                  className={cn(
                    "w-full text-left px-3 py-2 rounded text-xs font-mono border",
                    selectedFile === f.path
                      ? "bg-[var(--accent)]/10 border-[var(--accent)]/30 text-[var(--accent)]"
                      : "bg-[var(--bg-base)] border-[var(--border-default)] text-[var(--text-muted)] hover:border-[var(--border-default)]"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <FileCode className="h-3 w-3" />
                    {f.path}
                  </div>
                  <div className="text-[10px] text-[var(--text-secondary)] mt-0.5">
                    {f.size} bytes
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* File viewer (when a file is selected) */}
      {selectedFile && currentOrg && (
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2">
            Current file: {selectedFile}
          </h2>
          <FileViewer
            path={selectedFile}
            orgId={currentOrg.id}
            suggestionId={suggestion.id}
          />
        </div>
      )}

      {/* PR body preview */}
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2">
          PR body preview
        </h2>
        <Card className="border-[var(--border-default)] bg-[var(--bg-base)]">
          <pre className="text-sm text-[var(--text-muted)] p-4 whitespace-pre-wrap font-mono">
            {suggestion.pr_body}
          </pre>
        </Card>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {showOpenPR && (
          <OpenPRDialog
            suggestion={suggestion}
            onClose={() => setShowOpenPR(false)}
            onOpened={(num, url) => {
              setPrNumber(num);
              setPrUrl(url);
              setShowOpenPR(false);
              load();
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {confirmAction === "regenerate" && (
          <ConfirmDialog
            title="Regenerate suggestion?"
            description="This will re-run the LLM (or heuristic) against the current file state and replace the existing diff. The status will reset to 'pending'."
            confirmLabel="Regenerate"
            variant="primary"
            busy={busyAction === "regenerate"}
            onConfirm={handleRegenerate}
            onCancel={() => setConfirmAction(null)}
          />
        )}
        {confirmAction === "rejected" && (
          <ConfirmDialog
            title="Reject this suggestion?"
            description="The suggestion will be marked as rejected and hidden from the inbox. You can reopen it later from the suggestion's detail view."
            confirmLabel="Reject"
            variant="danger"
            busy={busyAction === "rejected"}
            onConfirm={() => handleStatusChange("rejected")}
            onCancel={() => setConfirmAction(null)}
          />
        )}
        {confirmAction === "merged" && (
          <ConfirmDialog
            title="Mark as merged?"
            description="The suggestion will be marked as merged. This is the terminal state for an opened PR — reopen it if you need to undo."
            confirmLabel="Mark merged"
            variant="primary"
            busy={busyAction === "merged"}
            onConfirm={() => handleStatusChange("merged")}
            onCancel={() => setConfirmAction(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
