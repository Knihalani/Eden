"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileJson,
  ChevronRight,
  ChevronDown,
} from "lucide-react";

interface FileNode {
  id: string;
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileNode[];
  content?: string;
}

interface FileTreeProps {
  files: FileNode[];
  selectedFileId?: string;
  onFileSelect?: (file: FileNode) => void;
  level?: number;
}

export function FileTree({ files, selectedFileId, onFileSelect, level = 0 }: FileTreeProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const toggleFolder = (folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const getFileIcon = (fileName: string) => {
    const ext = fileName.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "py":
      case "js":
      case "ts":
      case "tsx":
      case "jsx":
        return FileCode;
      case "json":
      case "yaml":
      case "yml":
        return FileJson;
      default:
        return File;
    }
  };

  return (
    <div className={cn("space-y-0.5", level > 0 && "ml-4")}>
      {files.map((file) => (
        <div key={file.id}>
          {file.type === "folder" ? (
            <div>
              <button
                onClick={() => toggleFolder(file.id)}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors",
                  "hover:bg-gray-50 text-gray-700"
                )}
              >
                {expandedFolders.has(file.id) ? (
                  <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
                )}
                {expandedFolders.has(file.id) ? (
                  <FolderOpen className="w-4 h-4 text-blue-500" />
                ) : (
                  <Folder className="w-4 h-4 text-blue-500" />
                )}
                <span className="text-sm font-medium">{file.name}</span>
              </button>
              {expandedFolders.has(file.id) && file.children && (
                <FileTree
                  files={file.children}
                  selectedFileId={selectedFileId}
                  onFileSelect={onFileSelect}
                  level={level + 1}
                />
              )}
            </div>
          ) : (
            <button
              onClick={() => onFileSelect?.(file)}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors",
                selectedFileId === file.id
                  ? "bg-blue-50 text-blue-700"
                  : "hover:bg-gray-50 text-gray-600"
              )}
            >
              {(() => {
                const Icon = getFileIcon(file.name);
                return <Icon className="w-4 h-4 text-gray-400" />;
              })()}
              <span className="text-sm">{file.name}</span>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}