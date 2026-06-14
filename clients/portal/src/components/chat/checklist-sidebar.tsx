"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CheckCircle2,
  Circle,
  Loader2,
  SkipForward,
  Sparkles,
  X,
} from "lucide-react";

// Spec-checklist types — were previously imported from "@/lib/types"
// but the module never exported them, leaving 5 pre-existing
// "no exported member" TS errors. Define them locally so the file
// type-checks and downstream consumers see real shapes.
type FieldStatus = "collected" | "skipped" | "pending";

interface ChecklistFieldState {
  status: FieldStatus;
  value?: unknown;
}

interface ChecklistCategory {
  label: string;
  fields: string[];
}

interface ChecklistState {
  fields: Record<string, ChecklistFieldState>;
  readiness_score?: number;
  user_marked_complete?: boolean;
}

// Empty placeholder lookups — the real labels / category layout
// comes from the spec-generation prompt + interview state. Kept as
// Record fallbacks so ``FIELD_LABELS[fieldName] ?? fieldName`` and
// ``FIELD_CATEGORIES.reduce(...)`` still type-check.
const FIELD_LABELS: Record<string, string> = {};
const FIELD_CATEGORIES: ChecklistCategory[] = [];

interface ChecklistSidebarProps {
  checklistState: ChecklistState | null;
  phase: string;
  isReadyForSpec: boolean;
  readinessScore: number;
  onGenerateSpec: () => void;
  onSkipInterview: () => void;
  onClose?: () => void;
}

const STATUS_CONFIG: Record<
  FieldStatus,
  { icon: typeof CheckCircle2; color: string; label: string }
> = {
  collected: {
    icon: CheckCircle2,
    color: "text-[var(--success)]",
    label: "Collected",
  },
  skipped: {
    icon: SkipForward,
    color: "text-[var(--text-muted)]",
    label: "Skipped",
  },
  pending: {
    icon: Circle,
    color: "text-[var(--text-muted)]",
    label: "Pending",
  },
};

function FieldItem({
  fieldName,
  fieldState,
  isPriority,
}: {
  fieldName: string;
  fieldState: ChecklistFieldState | undefined;
  isPriority: boolean;
}) {
  const status: FieldStatus = fieldState?.status ?? "pending";
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  const label = FIELD_LABELS[fieldName] ?? fieldName;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors cursor-default",
            isPriority && status === "pending" && "bg-[var(--accent-faint)]/40",
            status === "collected" && "bg-[var(--success-bg)]/30"
          )}
        >
          <Icon
            className={cn(
              "w-4 h-4 flex-shrink-0",
              config.color,
              status === "pending" && "opacity-40"
            )}
          />
          <span
            className={cn(
              "text-sm flex-1 truncate",
              status === "collected"
                ? "text-[var(--text-primary)]"
                : status === "skipped"
                ? "text-[var(--text-muted)] line-through"
                : "text-[var(--text-secondary)]"
            )}
          >
            {label}
          </span>
          {isPriority && status === "pending" && (
            <Badge variant="default" className="text-[10px] px-1.5 py-0 h-4">
              Next
            </Badge>
          )}
        </div>
      </TooltipTrigger>
      {fieldState?.value != null && (
        <TooltipContent side="left" className="max-w-xs">
          <p className="text-xs text-[var(--text-secondary)]">
            {String(fieldState.value).slice(0, 200)}
            {String(fieldState.value).length > 200 ? "..." : ""}
          </p>
        </TooltipContent>
      )}
    </Tooltip>
  );
}

export function ChecklistSidebar({
  checklistState,
  phase,
  isReadyForSpec,
  readinessScore,
  onGenerateSpec,
  onSkipInterview,
  onClose,
}: ChecklistSidebarProps) {
  const fields = useMemo(() => checklistState?.fields ?? {}, [checklistState]);

  return (
    <TooltipProvider delayDuration={300}>
      <ChecklistSidebarContent
        checklistState={checklistState}
        phase={phase}
        isReadyForSpec={isReadyForSpec}
        readinessScore={readinessScore}
        onGenerateSpec={onGenerateSpec}
        onSkipInterview={onSkipInterview}
        onClose={onClose}
        fields={fields}
      />
    </TooltipProvider>
  );
}

function ChecklistSidebarContent({
  checklistState,
  phase,
  isReadyForSpec,
  readinessScore,
  onGenerateSpec,
  onSkipInterview,
  onClose,
  fields,
}: ChecklistSidebarProps & { fields: Record<string, ChecklistFieldState> }) {

  const collectedCount = useMemo(
    () =>
      Object.values(fields).filter((f: ChecklistFieldState) => f.status === "collected").length,
    [fields]
  );
  const totalFields = FIELD_CATEGORIES.reduce(
    (sum: number, cat: { fields: string[] }) => sum + cat.fields.length,
    0
  );

  const priorityFields = useMemo(() => {
    if (!checklistState) return new Set<string>();
    // Priority = required pending fields first, then recommended pending
    const requiredPending = FIELD_CATEGORIES[0].fields.filter(
      (f: string) => fields[f]?.status === "pending"
    );
    if (requiredPending.length > 0) return new Set(requiredPending);
    const recPending = FIELD_CATEGORIES[1].fields.filter(
      (f: string) => fields[f]?.status === "pending"
    );
    return new Set(recPending.slice(0, 2));
  }, [fields, checklistState]);

  return (
    <div className="w-full lg:w-[320px] xl:w-[360px] flex-shrink-0 bg-[var(--bg-secondary)] border-t lg:border-t-0 lg:border-l border-[var(--border)] flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-4 bg-[var(--bg-primary)] border-b border-[var(--border)]">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            Spec Checklist
          </h2>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {collectedCount}/{totalFields}
            </Badge>
            {onClose && (
              <button
                onClick={onClose}
                className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                aria-label="Close checklist"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          Fields gathered during the interview
        </p>
      </div>

      {/* Progress */}
      <div className="px-5 py-3 border-b border-[var(--border)]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-[var(--text-secondary)]">
            Readiness
          </span>
          <span
            className={cn(
              "text-xs font-bold",
              readinessScore >= 0.7
                ? "text-[var(--success)]"
                : readinessScore >= 0.4
                ? "text-[var(--warning)]"
                : "text-[var(--text-muted)]"
            )}
          >
            {Math.round(readinessScore * 100)}%
          </span>
        </div>
        <div className="h-1.5 bg-[var(--border-subtle)] rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full relative transition-[width,background-color,box-shadow] duration-700 ease-[cubic-bezier(0.33,1,0.68,1)]",
              readinessScore >= 0.7
                ? "bg-[var(--success)]"
                : readinessScore >= 0.4
                ? "bg-[var(--warning)]"
                : "bg-[var(--accent)]"
            )}
            style={{
              width: `${Math.min(readinessScore * 100, 100)}%`,
              boxShadow:
                readinessScore > 0
                  ? `0 0 ${6 + readinessScore * 14}px ${
                      readinessScore >= 0.7
                        ? "rgba(22, 163, 74, 0.25)"
                        : readinessScore >= 0.4
                        ? "rgba(217, 119, 6, 0.25)"
                        : "rgba(16, 185, 129, 0.25)"
                    }`
                  : "none",
            }}
          >
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background:
                  "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.35) 50%, transparent 100%)",
                animation: "progress-shimmer 2.5s linear infinite",
              }}
            />
          </div>
        </div>
      </div>

      {/* Field Categories */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {FIELD_CATEGORIES.map((category) => {
          const categoryCollected = category.fields.filter(
            (f) => fields[f]?.status === "collected"
          ).length;
          const categoryTotal = category.fields.length;
          const isComplete = categoryCollected === categoryTotal;

          return (
            <div key={category.label}>
              <div className="flex items-center gap-2 mb-1.5 px-2">
                <span
                  className={cn(
                    "text-xs font-semibold uppercase tracking-wider",
                    isComplete
                      ? "text-[var(--success)]"
                      : "text-[var(--text-muted)]"
                  )}
                >
                  {category.label}
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">
                  ({categoryCollected}/{categoryTotal})
                </span>
                {isComplete && (
                  <CheckCircle2 className="w-3 h-3 text-[var(--success)]" />
                )}
              </div>
              <div className="space-y-0.5">
                {category.fields.map((fieldName) => (
                  <FieldItem
                    key={fieldName}
                    fieldName={fieldName}
                    fieldState={fields[fieldName]}
                    isPriority={priorityFields.has(fieldName)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="px-5 py-4 border-t border-[var(--border)] space-y-2.5 bg-[var(--bg-primary)]">
        {phase === "interviewing" && (
          <>
            <Button
              onClick={onGenerateSpec}
              disabled={!isReadyForSpec}
              className={cn(
                "w-full transition-all",
                isReadyForSpec
                  ? "bg-gradient-to-r from-[var(--accent)] to-[var(--terminal)] hover:shadow-lg"
                  : ""
              )}
            >
              <Sparkles className="w-4 h-4" />
              Generate Spec
            </Button>
            {!isReadyForSpec && (
              <p className="text-[11px] text-[var(--text-muted)] text-center">
                Fill required fields to enable spec generation
              </p>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onSkipInterview}
              className="w-full text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            >
              Skip Interview — Quick Create
            </Button>
          </>
        )}

        {phase === "generating_spec" && (
          <div className="flex items-center justify-center gap-2 py-2">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
            <span className="text-sm text-[var(--text-secondary)]">
              Generating spec...
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
