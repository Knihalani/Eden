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
  planning: "text-indigo-500",
  criticizing: "text-amber-500",
  refining: "text-cyan-500",
  fact_checking: "text-teal-500",
  executing: "text-blue-500",
  code_quality: "text-violet-500",
  verifying: "text-emerald-500",
  testing: "text-lime-500",
  archiving: "text-purple-500",
};

const STAGE_BG_COLORS: Record<string, string> = {
  planning: "bg-indigo-50",
  criticizing: "bg-amber-50",
  refining: "bg-cyan-50",
  fact_checking: "bg-teal-50",
  executing: "bg-blue-50",
  code_quality: "bg-violet-50",
  verifying: "bg-emerald-50",
  testing: "bg-lime-50",
  archiving: "bg-purple-50",
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
    <div className="relative flex items-center gap-1 p-4 bg-white border-b border-gray-100 overflow-x-auto">
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
                  isComplete && "bg-green-100 text-green-600",
                  isFailed && "bg-red-100 text-red-500",
                  isActive && cn(STAGE_BG_COLORS[stage], STAGE_COLORS[stage], "stage-active"),
                  !isComplete && !isFailed && !isActive && "bg-gray-100 text-gray-400"
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
                  isActive && "text-gray-900",
                  isComplete && "text-green-600",
                  isFailed && "text-red-500",
                  !isActive && !isComplete && !isFailed && "text-gray-400"
                )}
              >
                {STAGE_LABELS[stage]}
              </span>
            </div>
            {showTooltip && isHovered && (
              <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-48 p-2 bg-gray-900 text-white text-xs rounded-lg shadow-lg z-50">
                <div className="flex items-start gap-2">
                  <Info className="w-3 h-3 mt-0.5 flex-shrink-0 text-gray-400" />
                  <span>{STAGE_DESCRIPTIONS[stage]}</span>
                </div>
                <div className="absolute left-1/2 -translate-x-1/2 top-full w-2 h-2 bg-gray-900 rotate-45" />
              </div>
            )}
            {index < PIPELINE_STAGES.length - 1 && (
              <div
                className={cn(
                  "w-8 h-0.5 mx-1 mt-[-20px]",
                  isComplete ? "bg-green-300" : "bg-gray-200"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}