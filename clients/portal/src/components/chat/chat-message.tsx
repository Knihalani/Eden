"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { STATUS_COLORS, STAGE_LABELS } from "@/lib/types";
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

const STATUS_ICONS: Record<string, typeof Clock> = {
  pending: Clock,
  running: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
  human_review: AlertCircle,
  cancelled: XCircle,
};

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
          <div className="max-w-[75%] rounded-xl rounded-br-md bg-blue-600 text-white px-4 py-3">
            <p className="text-sm leading-relaxed">{content}</p>
          </div>
          <div className="flex items-center gap-2">
            {showTimestamp && metadata?.timestamp && (
              <span className="text-xs text-gray-400">
                {formatTimestamp(metadata.timestamp)}
              </span>
            )}
            <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center">
              <UserIcon className="w-3 h-3 text-blue-600" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (type === "stage-update") {
    return (
      <div className="flex justify-center message-appear">
        <div className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-full">
          <Loader2 className="w-4 h-4 text-gray-500 animate-spin" />
          <span className="text-xs font-medium text-gray-600">
            {metadata?.stage ? STAGE_LABELS[metadata.stage] || metadata.stage : "Processing..."}
          </span>
          <span className="flex gap-1 ml-1">
            <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
          </span>
        </div>
      </div>
    );
  }

  if (type === "file-reference") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg message-appear group relative">
        <FileCode className="w-4 h-4 text-gray-500" />
        <span className="text-sm text-gray-700 font-mono">{metadata?.filePath || content}</span>
        <ArrowRight className="w-4 h-4 text-gray-400" />
        {content && content !== metadata?.filePath && (
          <div className="absolute left-0 top-full mt-1 w-64 p-2 bg-white border border-gray-200 rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            <p className="text-xs text-gray-600 line-clamp-3">{content}</p>
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
        <div className="flex gap-3 pl-2 border-l-2 border-blue-200">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-100 to-indigo-200 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            {metadata?.agentName && (
              <p className="text-xs font-semibold text-blue-600 mb-1">{metadata.agentName}</p>
            )}
            <p className="text-sm leading-relaxed text-gray-800">{content}</p>
            {metadata?.isStreaming && (
              <span className="inline-block w-2 h-4 ml-1 bg-blue-400 animate-pulse" />
            )}
          </div>
        </div>
      </div>
    );
  }

  if (type === "tool-call") {
    return (
      <div className="message-appear">
        <div className="flex gap-3 pl-2 border-l-2 border-amber-200">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-100 to-orange-200 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            {metadata?.toolName && (
              <p className="text-xs font-semibold text-amber-700 mb-0.5">
                <span className="bg-amber-100 px-1.5 py-0.5 rounded text-amber-800">{metadata.toolName}</span>
              </p>
            )}
            <p className="text-xs font-mono text-gray-600 leading-relaxed">{content}</p>
          </div>
        </div>
      </div>
    );
  }

  if (type === "warning") {
    return (
      <div className="message-appear">
        <div className="flex gap-3 pl-2 border-l-2 border-amber-300 bg-amber-50 -mx-2 px-2 py-2 rounded-lg">
          <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center flex-shrink-0">
            <AlertCircle className="w-4 h-4 text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-amber-800 mb-0.5">Warning</p>
            <p className="text-sm text-amber-900 leading-relaxed">{content}</p>
          </div>
        </div>
      </div>
    );
  }

  if (type === "error") {
    return (
      <div className="message-appear">
        <div className="flex gap-3 pl-2 border-l-2 border-red-300 bg-red-50 -mx-2 px-2 py-2 rounded-lg">
          <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center flex-shrink-0">
            <XCircle className="w-4 h-4 text-red-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-red-800 mb-0.5">
              {metadata?.errorType || "Error"}
            </p>
            <p className="text-sm text-red-900 leading-relaxed">{content}</p>
          </div>
        </div>
      </div>
    );
  }

  if (type === "code-fragment") {
    return (
      <div className="message-appear">
        <div className="flex gap-3 pl-2 border-l-2 border-purple-200 bg-purple-50 -mx-2 px-2 py-2 rounded-lg">
          <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center flex-shrink-0">
            <FileCode className="w-4 h-4 text-purple-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-purple-700 mb-1">Code generated</p>
            <p className="text-xs text-gray-600 line-clamp-2 leading-relaxed">{content}</p>
          </div>
        </div>
      </div>
    );
  }

  if (type === "edp-preview") {
    return (
      <div className="message-appear">
        <div className="flex gap-3 pl-2 border-l-2 border-emerald-200 bg-emerald-50 -mx-2 px-3 py-2 rounded-lg">
          <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22c4-4 8-7.5 8-12a8 8 0 0 0-16 0c0 4.5 4 8 8 12z" />
              <path d="M12 22V10" />
              <path d="M8 14c1.5-1 3-2 4-2s2.5 1 4 2" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-emerald-700 mb-1">Environment Design Preview</p>
            <p className="text-sm text-gray-800 leading-relaxed">{content}</p>
          </div>
        </div>
      </div>
    );
  }

  // system message
  return (
    <div className="message-appear">
      <div className="flex gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-100 to-emerald-200 flex items-center justify-center flex-shrink-0">
          <svg className="w-4 h-4 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22c4-4 8-7.5 8-12a8 8 0 0 0-16 0c0 4.5 4 8 8 12z" />
            <path d="M12 22V10" />
            <path d="M8 14c1.5-1 3-2 4-2s2.5 1 4 2" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-relaxed">
            {content}
            {metadata?.isStreaming && (
              <span className="inline-block w-2 h-4 ml-1 bg-gray-400 animate-pulse" />
            )}
          </p>
          {metadata?.timestamp && (
            <span className="text-xs text-gray-400 mt-1 block">
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

export function StatusBadge({ status, size = "md" }: StatusBadgeProps) {
  const Icon = STATUS_ICONS[status] || Clock;
  const colorClass = STATUS_COLORS[status] || "bg-gray-100 text-gray-800";

  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full font-medium", colorClass, size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs")}>
      <Icon className={cn("animate-spin", status !== "running" && "hidden")} />
      {STAGE_LABELS[status] || status}
    </span>
  );
}