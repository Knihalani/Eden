"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

// Dynamic import to avoid SSR issues
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";

interface CodeHighlightBlockProps {
  code: string;
  language?: string;
  filePath?: string;
  isStreaming?: boolean;
  showLineNumbers?: boolean;
}

function detectLanguage(filePath?: string): string {
  if (!filePath) return "python";
  const ext = filePath.split(".").pop()?.toLowerCase();
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
  return map[ext || ""] || "python";
}

export function CodeHighlightBlock({
  code,
  language,
  filePath,
  isStreaming = false,
  showLineNumbers = true,
}: CodeHighlightBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const detectedLang = language || detectLanguage(filePath);

  return (
    <div className={cn("rounded-xl border overflow-hidden", isStreaming ? "border-[var(--accent)]" : "border-[var(--border)]")}>
      {filePath && (
        <div className="px-4 py-2 bg-[var(--bg-primary)] border-b border-[var(--border)] flex items-center justify-between">
          <span className="text-xs font-mono text-[var(--text-muted)]">{filePath}</span>
          <span className="text-xs px-1.5 py-0.5 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded font-medium">
            {detectedLang}
          </span>
        </div>
      )}
      <div className="relative">
        <SyntaxHighlighter
          language={detectedLang}
          style={vscDarkPlus}
          showLineNumbers={showLineNumbers}
          customStyle={{
            margin: 0,
            padding: "1rem",
            background: "#1e1e1e",
            fontSize: "0.8125rem",
            lineHeight: "1.6",
          }}
          codeTagProps={{
            style: {
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            },
          }}
          wrapLines
        >
          {code}
        </SyntaxHighlighter>
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]/100 hover:bg-[var(--text-primary)] rounded transition-colors"
          title="Copy code"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
        {isStreaming && (
          <div className="absolute bottom-2 right-10 w-2 h-4 bg-[var(--border-strong)] animate-pulse" />
        )}
      </div>
    </div>
  );
}