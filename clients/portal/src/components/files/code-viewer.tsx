"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { FileCode, Copy, Check } from "lucide-react";

interface CodeViewerProps {
  filePath?: string;
  content?: string;
  language?: string;
  isStreaming?: boolean;
}

export function CodeViewer({ filePath, content, language, isStreaming }: CodeViewerProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (content) {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const detectLanguage = (path?: string): string => {
    if (!path) return "text";
    const ext = path.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "py":
        return "python";
      case "js":
        return "javascript";
      case "ts":
      case "tsx":
        return "typescript";
      case "json":
        return "json";
      case "yaml":
      case "yml":
        return "yaml";
      case "md":
        return "markdown";
      default:
        return "text";
    }
  };

  const __detectedLang = language || detectLanguage(filePath);
  const lines = content?.split("\n") || [];

  return (
    <div className="flex flex-col h-full">
      {filePath && (
        <div className="px-4 py-2.5 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <FileCode className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
            <span className="text-xs font-mono text-[var(--text-secondary)] truncate">{filePath}</span>
          </div>
          <button
            onClick={handleCopy}
            disabled={!content}
            className={cn(
              "p-1.5 rounded-lg transition-colors flex-shrink-0",
              "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
            title="Copy code"
          >
            {copied ? (
              <Check className="w-4 h-4 text-[var(--terminal)]" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {content ? (
          <table className="w-full text-sm font-mono">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="hover:bg-[var(--bg-secondary)]">
                  <td className="px-4 py-0.5 text-right text-[var(--text-muted)] select-none w-12 border-r border-[var(--border-subtle)]">
                    {i + 1}
                  </td>
                  <td className="px-4 py-0.5 text-[var(--text-primary)] whitespace-pre">
                    {line || " "}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-12 h-12 bg-[var(--bg-tertiary)] rounded-xl flex items-center justify-center mb-3">
              <FileCode className="w-6 h-6 text-[var(--text-muted)]" />
            </div>
            <p className="text-sm text-[var(--text-muted)]">Select a file to view its contents</p>
          </div>
        )}
      </div>
      {isStreaming && (
        <div className="px-4 py-2 bg-[var(--accent-faint)] border-t border-[var(--accent)]/30 flex items-center gap-2">
          <div className="w-2 h-2 bg-[var(--accent)] rounded-full animate-pulse" />
          <span className="text-xs text-[var(--accent)]">Streaming...</span>
        </div>
      )}
    </div>
  );
}