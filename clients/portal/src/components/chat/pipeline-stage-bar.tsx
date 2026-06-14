"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { PIPELINE_STAGES, STAGE_LABELS } from "@/lib/types";
import {
  Lightbulb,
  MessageSquare,
  RefreshCw,
  CheckCircle,
  Cpu,
  Code2,
  ShieldCheck,
  FlaskConical,
  Archive,
  Info,
} from "lucide-react";

const STAGE_ICONS: Record<string, typeof Lightbulb> = {
  planning: Lightbulb,
  criticizing: MessageSquare,
  refining: RefreshCw,
  fact_checking: CheckCircle,
  executing: Cpu,
  code_quality: Code2,
  verifying: ShieldCheck,
  testing: FlaskConical,
  archiving: Archive,
};

const STAGE_COLORS: Record<string, string> = {
  planning: "text-[var(--accent)]",
  criticizing: "text-[var(--warning)]",
  refining: "text-[var(--accent)]",
  fact_checking: "text-[var(--terminal)]",
  executing: "text-[var(--accent)]",
  code_quality: "text-[var(--accent)]",
  verifying: "text-[var(--terminal)]",
  testing: "text-[var(--terminal)]",
  archiving: "text-[var(--accent)]",
};

const STAGE_BG_COLORS: Record<string, string> = {
  planning: "bg-[var(--accent-faint)]",
  criticizing: "bg-[var(--warning-bg)]",
  refining: "bg-[var(--accent-faint)]",
  fact_checking: "bg-[var(--terminal-faint)]",
  executing: "bg-[var(--accent-faint)]",
  code_quality: "bg-[var(--accent-faint)]",
  verifying: "bg-[var(--terminal-faint)]",
  testing: "bg-[var(--terminal-faint)]",
  archiving: "bg-[var(--accent-faint)]",
};

const STAGE_DESCRIPTIONS: Record<string, string> = {
  planning: "Analyzes requirements and creates a detailed execution plan",
  criticizing: "Reviews and critiques the proposed solution for potential issues",
  refining: "Iteratively improves the plan based on feedback",
  fact_checking: "Verifies all facts and references used in the solution",
  executing: "Executes the code generation and implementation",
  code_quality: "Reviews code for quality, best practices, and maintainability",
  verifying: "Verifies the implementation matches the requirements",
  testing: "Runs tests to ensure the solution works correctly",
  archiving: "Archives the final solution and generates documentation",
};

interface PipelineStageBarProps {
  currentStage: string;
  completedStages: string[];
  failedStages: string[];
}

export function PipelineStageBar({
  currentStage,
  completedStages,
  failedStages,
}: PipelineStageBarProps) {
  const [hoveredStage, setHoveredStage] = useState<string | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);

  const isStageComplete = (stage: string) => completedStages.includes(stage);
  const isStageFailed = (stage: string) => failedStages.includes(stage);
  const isStageActive = (stage: string) => stage === currentStage && !isStageComplete(stage) && !isStageFailed(stage);

  return (
    <div className="relative flex items-center gap-1 p-4 bg-[var(--bg-primary)] border-b border-[var(--border-subtle)] overflow-x-auto">
      {PIPELINE_STAGES.map((stage, index) => {
        const Icon = STAGE_ICONS[stage];
        const isComplete = isStageComplete(stage);
        const isFailed = isStageFailed(stage);
        const isActive = isStageActive(stage);
        const isHovered = hoveredStage === stage;

        return (
          <div
            key={stage}
            className="flex items-center relative"
            onMouseEnter={() => {
              setHoveredStage(stage);
              setShowTooltip(true);
            }}
            onMouseLeave={() => {
              setHoveredStage(null);
              setShowTooltip(false);
            }}
          >
            <div className="flex flex-col items-center cursor-pointer">
              <div
                className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-250",
                  isComplete && "bg-[var(--terminal-faint)] text-[var(--terminal)]",
                  isFailed && "bg-[var(--error-dim)] text-[var(--error)]",
                  isActive && cn(STAGE_BG_COLORS[stage], STAGE_COLORS[stage], "stage-active"),
                  !isComplete && !isFailed && !isActive && "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                )}
              >
                {isComplete ? (
                  <CheckCircle className="w-5 h-5" />
                ) : isFailed ? (
                  <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                  </svg>
                ) : (
                  <Icon className={cn("w-5 h-5", isActive && STAGE_COLORS[stage])} />
                )}
              </div>
              <span
                className={cn(
                  "mt-1.5 text-xs font-medium",
                  isActive && "text-[var(--text-primary)]",
                  isComplete && "text-[var(--terminal)]",
                  isFailed && "text-[var(--error)]",
                  !isActive && !isComplete && !isFailed && "text-[var(--text-muted)]"
                )}
              >
                {STAGE_LABELS[stage]}
              </span>
            </div>
            {showTooltip && isHovered && (
              <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-48 p-2 bg-[var(--bg-primary)] text-[var(--bg-primary)] text-xs rounded-lg shadow-lg z-50">
                <div className="flex items-start gap-2">
                  <Info className="w-3 h-3 mt-0.5 flex-shrink-0 text-[var(--text-muted)]" />
                  <span>{STAGE_DESCRIPTIONS[stage]}</span>
                </div>
                <div className="absolute left-1/2 -translate-x-1/2 top-full w-2 h-2 bg-[var(--bg-primary)] rotate-45" />
              </div>
            )}
            {index < PIPELINE_STAGES.length - 1 && (
              <div
                className={cn(
                  "w-8 h-0.5 mx-1 mt-[-20px]",
                  isComplete ? "bg-green-300" : "bg-[var(--bg-tertiary)]"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}