"use client";

import * as React from "react";
import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  filename?: string;
}

function detectLanguage(filename?: string): string {
  if (!filename) return "text";
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    py: "python",
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    sh: "bash",
    bash: "bash",
  };
  return map[ext || ""] || "text";
}

export const CodeBlock = React.forwardRef<HTMLPreElement, CodeBlockProps>(
  ({ className, code, language, showLineNumbers = true, filename, ...props }, ref) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    const detectedLang = language || detectLanguage(filename);
    const lines = code.split("\n");

    return (
      <div className={cn("relative group rounded-lg border border-[var(--border)] bg-[var(--bg-base)]", className)}>
        {(filename || language) && (
          <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--bg-surface)]">
            <span className="text-xs font-mono text-[var(--text-muted)]">
              {filename || detectedLang}
            </span>
            {language && !filename && (
              <span className="text-xs px-1.5 py-0.5 bg-[var(--bg-elevated)] text-[var(--text-muted)] rounded font-medium">
                {language}
              </span>
            )}
          </div>
        )}
        <div className="relative">
          <button
            onClick={handleCopy}
            className={cn(
              "absolute top-2 right-2 p-1.5 rounded-lg transition-all opacity-0 group-hover:opacity-100",
              "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
            )}
            title="Copy code"
          >
            {copied ? (
              <Check className="w-4 h-4 text-[var(--success)]" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
          <pre
            ref={ref}
            className={cn(
              "p-4 overflow-x-auto text-sm font-mono leading-relaxed",
              "text-[var(--text-secondary)]"
            )}
            {...props}
          >
            {showLineNumbers ? (
              <code className="block">
                <table className="w-full">
                  <tbody>
                    {lines.map((line, i) => (
                      <tr key={i}>
                        <td className="pr-4 text-right text-[var(--text-faint)] select-none w-10 align-top">
                          {i + 1}
                        </td>
                        <td className="whitespace-pre text-[var(--text-secondary)]">
                          {line || " "}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </code>
            ) : (
              <code className="block whitespace-pre">{code}</code>
            )}
          </pre>
        </div>
      </div>
    );
  }
);
CodeBlock.displayName = "CodeBlock";
