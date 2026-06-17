"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { STAGE_LABELS } from "@/lib/types";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  FileCode,
  ArrowRight,
  User as UserIcon,
  Copy,
  Check,
} from "lucide-react";
import { CodeHighlightBlock } from "./code-highlighter";

interface ChatMessageProps {
  type: "user" | "system" | "stage-update" | "file-reference" | "code-block" | "agent" | "tool-call" | "warning" | "error" | "code-fragment" | "edp-preview";
  content: string;
  metadata?: {
    stage?: string;
    filePath?: string;
    language?: string;
    isStreaming?: boolean;
    timestamp?: string;
    agentName?: string;
    toolName?: string;
    errorType?: string;
    severity?: string;
  };
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function ChatMessage({ type, content, metadata }: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const [showTimestamp, setShowTimestamp] = useState(false);

  if (type === "user") {
    return (
      <div
        className="flex justify-end message-appear"
        onMouseEnter={() => setShowTimestamp(true)}
        onMouseLeave={() => setShowTimestamp(false)}
      >
        <div className="flex flex-col items-end gap-1">
          <div className="max-w-[75%] rounded-xl rounded-br-md bg-[var(--accent)] text-[var(--bg-primary)] px-4 py-3">
            <p className="text-sm leading-relaxed">{content}</p>
          </div>
          <div className="flex items-center gap-2">
            {showTimestamp && metadata?.timestamp && (
              <span className="text-xs text-[var(--text-muted)]">
                {formatTimestamp(metadata.timestamp)}
              </span>
            )}
            <div className="w-6 h-6 rounded-full bg-[var(--accent-faint)] flex items-center justify-center">
              <UserIcon className="w-3 h-3 text-[var(--accent)]" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (type === "stage-update") {
    return (
      <div className="flex justify-center message-appear">
        <div className="flex items-center gap-2 px-4 py-2 bg-[var(--bg-tertiary)] rounded-full">
          <Loader2 className="w-4 h-4 text-[var(--text-muted)] animate-spin" />
          <span className="text-xs font-medium text-[var(--text-secondary)]">
            {metadata?.stage ? STAGE_LABELS[metadata.stage] || metadata.stage : "Processing..."}
          </span>
          <span className="flex gap-1 ml-1">
            <span className="w-1.5 h-1.5 bg-[var(--border-strong)] rounded-full animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 bg-[var(--border-strong)] rounded-full animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 bg-[var(--border-strong)] rounded-full animate-bounce [animation-delay:300ms]" />
          </span>
        </div>
      </div>
    );
  }

  if (type === "file-reference") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg message-appear group relative">
        <FileCode className="w-4 h-4 text-[var(--text-muted)]" />
        <span className="text-sm text-[var(--text-secondary)] font-mono">{metadata?.filePath || content}</span>
        <ArrowRight className="w-4 h-4 text-[var(--text-muted)]" />
        {content && content !== metadata?.filePath && (
          <div className="absolute left-0 top-full mt-1 w-64 p-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            <p className="text-xs text-[var(--text-secondary)] line-clamp-3">{content}</p>
          </div>
        )}
      </div>
    );
  }

  if (type === "code-block") {
    return (
      <div className="message-appear">
        <CodeHighlightBlock
          code={content}
          language={metadata?.language}
          filePath={metadata?.filePath}
          isStreaming={metadata?.isStreaming}
          showLineNumbers
        />
      </div>
    );
  }

  if (type === "agent") {
    return (
      <div className="message-appear">
        <div className="flex gap-3 pl-2 border-l-2 border-[var(--accent)]">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-100 to-[var(--accent)] flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            {metadata?.agentName && (
              <p className="text-xs font-semibold text-[var(--accent)] mb-1">{metadata.agentName}</p>
            )}
            <p className="text-sm leading-relaxed text-[var(--text-primary)]">{content}</p>
            {metadata?.isStreaming && (
              <span className="inline-block w-2 h-4 ml-1 bg-[var(--accent)] animate-pulse" />
            )}
          </div>
        </div>
      </div>
    );
  }

  if (type === "tool-call") {
    return (
      <div className="message-appear">
        <div className="flex gap-3 pl-2 border-l-2 border-[var(--warning)]">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-100 to-orange-200 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-[var(--warning)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            {metadata?.toolName && (
              <p className="text-xs font-semibold text-[var(--warning)] mb-0.5">
                <span className="bg-[var(--warning-bg)] px-1.5 py-0.5 rounded text-[var(--warning)]">{metadata.toolName}</span>
              </p>
            )}
            <p className="text-xs font-mono text-[var(--text-secondary)] leading-relaxed">{content}</p>
          </div>
        </div>
      </div>
    );
  }

  if (type === "warning") {
    return (
      <div className="message-appear">
        <div className="flex gap-3 pl-2 border-l-2 border-[var(--warning)] bg-[var(--warning-bg)] -mx-2 px-2 py-2 rounded-lg">
          <div className="w-8 h-8 rounded-lg bg-[var(--warning-bg)] flex items-center justify-center flex-shrink-0">
            <AlertCircle className="w-4 h-4 text-[var(--warning)]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-[var(--warning)] mb-0.5">Warning</p>
            <p className="text-sm text-[var(--warning)] leading-relaxed">{content}</p>
          </div>
        </div>
      </div>
    );
  }

  if (type === "error") {
    return (
      <div className="message-appear">
        <div className="flex gap-3 pl-2 border-l-2 border-[var(--error)] bg-[var(--error-dim)] -mx-2 px-2 py-2 rounded-lg">
          <div className="w-8 h-8 rounded-lg bg-[var(--error-dim)] flex items-center justify-center flex-shrink-0">
            <XCircle className="w-4 h-4 text-[var(--error)]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-[var(--error)] mb-0.5">
              {metadata?.errorType || "Error"}
            </p>
            <p className="text-sm text-[var(--error)] leading-relaxed">{content}</p>
          </div>
        </div>
      </div>
    );
  }

  if (type === "code-fragment") {
    return (
      <div className="message-appear">
        <div className="flex gap-3 pl-2 border-l-2 border-[var(--accent)] bg-[var(--accent-faint)] -mx-2 px-2 py-2 rounded-lg">
          <div className="w-8 h-8 rounded-lg bg-[var(--accent-faint)] flex items-center justify-center flex-shrink-0">
            <FileCode className="w-4 h-4 text-[var(--accent)]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-[var(--accent)] mb-1">Code generated</p>
            <p className="text-xs text-[var(--text-secondary)] line-clamp-2 leading-relaxed">{content}</p>
          </div>
        </div>
      </div>
    );
  }

  if (type === "edp-preview") {
    return (
      <div className="message-appear">
        <div className="flex gap-3 pl-2 border-l-2 border-[var(--terminal)] bg-[var(--terminal-faint)] -mx-2 px-3 py-2 rounded-lg">
          <div className="w-8 h-8 rounded-lg bg-[var(--terminal-faint)] flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-[var(--terminal)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22c4-4 8-7.5 8-12a8 8 0 0 0-16 0c0 4.5 4 8 8 12z" />
              <path d="M12 22V10" />
              <path d="M8 14c1.5-1 3-2 4-2s2.5 1 4 2" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-[var(--terminal)] mb-1">Environment Design Preview</p>
            <p className="text-sm text-[var(--text-primary)] leading-relaxed">{content}</p>
          </div>
        </div>
      </div>
    );
  }

  // system message
  return (
    <div className="message-appear">
      <div className="flex gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--terminal)] to-[var(--terminal)] flex items-center justify-center flex-shrink-0">
          <svg className="w-4 h-4 text-[var(--terminal)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22c4-4 8-7.5 8-12a8 8 0 0 0-16 0c0 4.5 4 8 8 12z" />
            <path d="M12 22V10" />
            <path d="M8 14c1.5-1 3-2 4-2s2.5 1 4 2" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-relaxed">
            {content}
            {metadata?.isStreaming && (
              <span className="inline-block w-2 h-4 ml-1 bg-[var(--border-strong)] animate-pulse" />
            )}
          </p>
          {metadata?.timestamp && (
            <span className="text-xs text-[var(--text-muted)] mt-1 block">
              {formatTimestamp(metadata.timestamp)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

interface StatusBadgeProps {
  status: string;
  size?: "sm" | "md";
}

export function StageStatusBadge({ status, size = "md" }: StatusBadgeProps) {
  return (
    <span className={cn("inline-block", size === "sm" ? "[&>span]:px-2 [&>span]:py-0.5 [&>span]:text-[10px]" : "")}>
      <StatusBadge status={status} />
    </span>
  );
}