"use client";

import { CheckCircle2, FileCode } from "lucide-react";
import type { ImprovementPlan } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { DiffViewer } from "@/components/improve/diff-viewer";
import { PlanSummaryPanel } from "@/components/improve/plan-summary-panel";

export function PlanDetailBody({
  plan,
  canAct,
  reviewPane,
  setReviewPane,
  diffMode,
  setDiffMode,
  editDiff,
  setEditDiff,
  editTitle,
  setEditTitle,
  editSummary,
  setEditSummary,
  setDirty,
}: {
  plan: ImprovementPlan;
  canAct: boolean;
  reviewPane: "diff" | "summary";
  setReviewPane: (pane: "diff" | "summary") => void;
  diffMode: "unified" | "split";
  setDiffMode: (mode: "unified" | "split") => void;
  editDiff: string;
  setEditDiff: (v: string) => void;
  editTitle: string;
  setEditTitle: (v: string) => void;
  editSummary: string;
  setEditSummary: (v: string) => void;
  setDirty: (v: boolean) => void;
}) {
  const files = plan.files_changed ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--text-muted)]">
              {reviewPane === "diff" ? "Diff" : "Summary"}
            </h2>
            <div
              role="group"
              aria-label="Review pane"
              data-testid="plan-review-pane-toggle"
              className="inline-flex h-8 items-center gap-0.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] p-0.5"
            >
              <Button
                type="button"
                size="sm"
                variant={reviewPane === "diff" ? "secondary" : "ghost"}
                className="h-7 px-2.5 text-xs"
                aria-pressed={reviewPane === "diff"}
                onClick={() => setReviewPane("diff")}
              >
                Diff
              </Button>
              <Button
                type="button"
                size="sm"
                variant={reviewPane === "summary" ? "secondary" : "ghost"}
                className="h-7 px-2.5 text-xs"
                aria-pressed={reviewPane === "summary"}
                onClick={() => setReviewPane("summary")}
              >
                Summary
              </Button>
            </div>
          </div>
          {reviewPane === "diff" ? (
            <DiffViewer
              diff={editDiff}
              diffMode={diffMode}
              onModeChange={setDiffMode}
              emptyMessage="No unified diff on this plan yet."
            />
          ) : (
            <PlanSummaryPanel
              plan={
                {
                  ...plan,
                  title: editTitle || plan.title,
                  summary: editSummary || plan.summary,
                } as ImprovementPlan
              }
            />
          )}
        </section>

        {canAct && (
          <section>
            <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2">
              Edit diff before approve
            </h2>
            <Panel tone="flat" padding="md" className="bg-[var(--bg-base)]">
              <div className="space-y-3">
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
            </Panel>
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
          <Panel tone="flat" padding="sm" className="text-sm">
            <p className="text-[var(--text-muted)] text-xs mb-1">Blast radius</p>
            <p className="font-medium capitalize">{plan.estimated_blast_radius}</p>
          </Panel>
        )}

        {plan.status === "pr_opened" && (
          <Panel
            tone="flat"
            padding="sm"
            className="border-[var(--accent)]/20 bg-[var(--accent)]/5 text-sm flex items-start gap-2"
          >
            <CheckCircle2 className="h-4 w-4 text-[var(--accent)] mt-0.5" />
            <p className="text-[var(--text-muted)]">
              PR opened. N01 verify runs on the branch automatically.
            </p>
          </Panel>
        )}
      </div>
    </div>
  );
}
