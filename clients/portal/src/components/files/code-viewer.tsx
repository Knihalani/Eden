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

  const detectedLang = language || detectLanguage(filePath);
  const lines = content?.split("\n") || [];

  return (
    <div className="flex flex-col h-full">
      {filePath && (
        <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <FileCode className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <span className="text-xs font-mono text-gray-600 truncate">{filePath}</span>
          </div>
          <button
            onClick={handleCopy}
            disabled={!content}
            className={cn(
              "p-1.5 rounded-lg transition-colors flex-shrink-0",
              "text-gray-400 hover:text-gray-600 hover:bg-gray-200",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
            title="Copy code"
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-500" />
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
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-4 py-0.5 text-right text-gray-400 select-none w-12 border-r border-gray-100">
                    {i + 1}
                  </td>
                  <td className="px-4 py-0.5 text-gray-800 whitespace-pre">
                    {line || " "}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mb-3">
              <FileCode className="w-6 h-6 text-gray-400" />
            </div>
            <p className="text-sm text-gray-500">Select a file to view its contents</p>
          </div>
        )}
      </div>
      {isStreaming && (
        <div className="px-4 py-2 bg-blue-50 border-t border-blue-100 flex items-center gap-2">
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
          <span className="text-xs text-blue-600">Streaming...</span>
        </div>
      )}
    </div>
  );
}