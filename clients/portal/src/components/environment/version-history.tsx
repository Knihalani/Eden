"use client";

import { useState } from "react";

import { ChevronDown, ChevronUp, GitBranch, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface Version {
  iteration: number;
  code: string;
  timestamp: string;
  trigger?: string;
}

interface VersionHistoryProps {
  jobId: string;
  versions: Version[];
  onSelectVersion: (version: Version) => void;
  selectedIteration?: number;
}

export function VersionHistory({ versions, onSelectVersion, selectedIteration }: VersionHistoryProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const visible = isExpanded ? versions : versions.slice(-3);

  if (versions.length === 0) {
    return (
      <div className="text-center py-6 text-sm text-[var(--text-muted)]">
        No version history available
      </div>
    );
  }

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[var(--bg-primary)] hover:bg-[var(--bg-muted)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-[var(--text-muted)]" />
          <span className="text-sm font-medium text-[var(--text-primary)]">
            Version History
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            ({versions.length} {versions.length === 1 ? "version" : "versions"})
          </span>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" />
        ) : (
          <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
        )}
      </button>

      {isExpanded && (
        <div className="divide-y divide-[var(--border)]">
          {visible.map((version) => (
            <button
              key={version.iteration}
              onClick={() => onSelectVersion(version)}
              className={cn(
                "w-full flex items-center justify-between px-4 py-3 text-left transition-colors",
                "hover:bg-[var(--accent-bg)]",
                selectedIteration === version.iteration && "bg-[var(--accent-bg)]"
              )}
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono px-1.5 py-0.5 bg-[var(--bg-muted)] rounded text-[var(--text-secondary)]">
                  v{version.iteration}
                </span>
                <div>
                  <p className="text-sm text-[var(--text-primary)]">
                    Iteration {version.iteration}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {version.trigger || "executor"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                <Clock className="w-3 h-3" />
                {version.timestamp ? new Date(version.timestamp).toLocaleString() : "—"}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}