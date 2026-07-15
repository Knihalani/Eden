"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileCode,
  GitPullRequest,
  RefreshCw,
  Save,
  Send,
  XCircle,
} from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { improvePlansApi, type ImprovementPlan } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { ImprovePlanStatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { NoOrgState } from "@/components/ui/no-org-state";
import { DiffViewer } from "@/components/improve/diff-viewer";
import { PlanKindBadge } from "@/components/improve/plan-kind-badge";
import { errorFromCaught } from "@/lib/safe-error-message";

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  variant,
  busy,
  onConfirm,
  onCancel,
}: {
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
            <h3 className="text-base font-semibold text-[var(--text-primary)]">{title}</h3>
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

export default function ImprovementPlanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [plan, setPlan] = useState<ImprovementPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [editDiff, setEditDiff] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"reject" | "approve" | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError("");
    try {
      const data = await improvePlansApi.getPlan(currentOrg.id, id);
      const p = data.data.plan;
      setPlan(p);
      setEditDiff(p.diff_unified ?? "");
      setEditTitle(p.title ?? "");
      setEditSummary(p.summary ?? "");
      setDirty(false);
    } catch (err) {
      setError(errorFromCaught(err, "Failed to load plan"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const canAct =
    plan &&
    !["rejected", "merged", "superseded"].includes(plan.status) &&
    plan.status !== "pr_opened";

  async function handleSaveDraft() {
    if (!currentOrg || !plan) return;
    setBusyAction("save");
    try {
      const data = await improvePlansApi.patchPlan(currentOrg.id, plan.id, {
        diff_unified: editDiff,
        title: editTitle,
        summary: editSummary,
      });
      setPlan(data.data.plan);
      setDirty(false);
      toast.success("Draft saved");
    } catch (err) {
      toast.error(errorFromCaught(err, "Save failed"));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleApprove() {
    if (!currentOrg || !plan) return;
    setBusyAction("approve");
    try {
      if (dirty) {
        await improvePlansApi.patchPlan(currentOrg.id, plan.id, {
          diff_unified: editDiff,
          title: editTitle,
          summary: editSummary,
        });
      }
      const data = await improvePlansApi.approvePlan(currentOrg.id, plan.id);
      const prUrl = data.data.pr_url;
      const prNum = data.data.pr_number;
      toast.success(
        prNum ? `PR #${prNum} opened` : "Plan approved — PR opened",
      );
      setConfirmAction(null);
      await load();
      if (prUrl) window.open(prUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(errorFromCaught(err, "Approve failed"));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleReject() {
    if (!currentOrg || !plan) return;
    setBusyAction("reject");
    try {
      await improvePlansApi.rejectPlan(currentOrg.id, plan.id, rejectReason);
      toast.success("Plan rejected");
      setConfirmAction(null);
      await load();
    } catch (err) {
      toast.error(errorFromCaught(err, "Reject failed"));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSnooze() {
    if (!currentOrg || !plan) return;
    setBusyAction("snooze");
    try {
      const until = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
      await improvePlansApi.snoozePlan(currentOrg.id, plan.id, until);
      toast.success("Snoozed for 7 days");
      await load();
    } catch (err) {
      toast.error(errorFromCaught(err, "Snooze failed"));
    } finally {
      setBusyAction(null);
    }
  }

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="Improvement plan"
        description="Select an organization to review this plan."
      />
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

  if (error || !plan) {
    return (
      <div className="p-6">
        <Button variant="ghost" onClick={() => router.push("/improve/plans")} className="mb-4">
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
              {error || "Plan not found."}
            </span>
            <button
              type="button"
              onClick={() => void load()}
              className="text-xs font-medium underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        </Card>
      </div>
    );
  }

  const files = plan.files_changed ?? [];

  return (
    <PageContent size="wide">
      <Button variant="ghost" onClick={() => router.push("/improve/plans")} size="sm">
        <ArrowLeft className="h-4 w-4 mr-1" />
        Back to inbox
      </Button>

      <PageHeader
        eyebrow="Automate"
        title={plan.title || "Improvement plan"}
        subtitle={plan.summary ?? undefined}
        icon={GitPullRequest}
        actions={
          <div className="flex flex-wrap gap-2">
            {canAct && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleSaveDraft()}
                  disabled={!dirty || busyAction === "save"}
                >
                  {busyAction === "save" ? (
                    <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-1" />
                  )}
                  Save draft
                </Button>
                <Button
                  size="sm"
                  onClick={() => setConfirmAction("approve")}
                  disabled={busyAction === "approve"}
                >
                  <Send className="h-4 w-4 mr-1" />
                  Approve & open PR
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmAction("reject")}
                  disabled={busyAction === "reject"}
                >
                  <XCircle className="h-4 w-4 mr-1" />
                  Reject
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleSnooze()}
                  disabled={busyAction === "snooze"}
                >
                  <Clock className="h-4 w-4 mr-1" />
                  Snooze 7d
                </Button>
              </>
            )}
            {plan.pr_url && (
              <a href={plan.pr_url} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm">
                  <ExternalLink className="h-4 w-4 mr-1" />
                  View PR #{plan.pr_number ?? ""}
                </Button>
              </a>
            )}
          </div>
        }
      />

      <div className="flex items-center gap-2 mb-6 flex-wrap -mt-4">
        <PlanKindBadge kind={plan.plan_kind} />
        <ImprovePlanStatusBadge status={plan.status} />
        {plan.diff_edited && (
          <Badge variant="outline" className="text-xs">
            Diff edited
          </Badge>
        )}
        {plan.source_ref && (
          <span className="text-xs text-[var(--text-muted)] font-mono">{plan.source_ref}</span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <section>
            <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2">
              Unified diff preview
            </h2>
            <DiffViewer
              diff={editDiff}
              diffMode={diffMode}
              onModeChange={setDiffMode}
              emptyMessage="No unified diff on this plan yet."
            />
          </section>

          {canAct && (
            <section>
              <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2">
                Edit diff before approve
              </h2>
              <Card className="border-[var(--border-default)] bg-[var(--bg-base)]">
                <div className="p-3 space-y-3">
                  <input
                    value={editTitle}
                    onChange={(e) => {
                      setEditTitle(e.target.value);
                      setDirty(true);
                    }}
                    aria-label="Plan title"
                    className="w-full bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-sm text-[var(--text-primary)]"
                  />
                  <input
                    value={editSummary}
                    onChange={(e) => {
                      setEditSummary(e.target.value);
                      setDirty(true);
                    }}
                    aria-label="Plan summary"
                    placeholder="Summary"
                    className="w-full bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-sm text-[var(--text-primary)]"
                  />
                  <textarea
                    value={editDiff}
                    onChange={(e) => {
                      setEditDiff(e.target.value);
                      setDirty(true);
                    }}
                    aria-label="Unified diff"
                    className="w-full h-64 bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-xs font-mono text-[var(--text-primary)]"
                    spellCheck={false}
                  />
                </div>
              </Card>
            </section>
          )}
        </div>

        <div className="space-y-4">
          <section>
            <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2">
              Files ({files.length})
            </h2>
            {files.length === 0 ? (
              <div className="text-sm text-[var(--text-muted)] italic p-3 bg-[var(--bg-base)] border border-[var(--border-default)] rounded">
                No files attached.
              </div>
            ) : (
              <div className="space-y-1">
                {files.map((f) => (
                  <div
                    key={f.path}
                    className="px-3 py-2 rounded text-xs font-mono border bg-[var(--bg-base)] border-[var(--border-default)] text-[var(--text-muted)]"
                  >
                    <div className="flex items-center gap-1.5">
                      <FileCode className="h-3 w-3" />
                      {f.path}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {plan.estimated_blast_radius && (
            <Card className="border-[var(--border-default)] bg-[var(--bg-base)] p-3 text-sm">
              <p className="text-[var(--text-muted)] text-xs mb-1">Blast radius</p>
              <p className="font-medium capitalize">{plan.estimated_blast_radius}</p>
            </Card>
          )}

          {plan.status === "pr_opened" && (
            <Card className="border-[var(--accent)]/20 bg-[var(--accent)]/5 p-3 text-sm flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-[var(--accent)] mt-0.5" />
              <p className="text-[var(--text-muted)]">
                PR opened. N01 verify runs on the branch automatically.
              </p>
            </Card>
          )}
        </div>
      </div>

      <AnimatePresence>
        {confirmAction === "approve" && (
          <ConfirmDialog
            title="Approve and open PR?"
            description="Approve always opens a GitHub PR immediately with the current diff. You can edit the diff above before confirming."
            confirmLabel="Approve & open PR"
            variant="primary"
            busy={busyAction === "approve"}
            onConfirm={() => void handleApprove()}
            onCancel={() => setConfirmAction(null)}
          />
        )}
        {confirmAction === "reject" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[var(--bg-base)]/70 z-50 flex items-center justify-center p-4"
            onClick={() => setConfirmAction(null)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg w-full max-w-md p-5 space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-base font-semibold text-[var(--text-primary)]">
                Reject this plan?
              </h3>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Optional reason (helps dedupe future sweeps)"
                aria-label="Rejection reason"
                className="w-full h-20 bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-2 text-sm"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirmAction(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void handleReject()}
                  disabled={busyAction === "reject"}
                  className="bg-[var(--error)] hover:bg-[var(--error)]/600 text-[var(--bg-primary)]"
                >
                  Reject
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageContent>
  );
}
