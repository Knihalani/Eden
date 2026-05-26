"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { PipelineStageBar } from "./pipeline-stage-bar";
import { ChatMessage } from "./chat-message";
import { ChatInput } from "./chat-input";
import { FileTree } from "@/components/files/file-tree";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

export interface ChatMessageData {
  id: string;
  type: "user" | "system" | "stage-update" | "file-reference" | "code-block" | "agent" | "tool-call" | "warning" | "error" | "code-fragment" | "edp-preview";
  content: string;
  metadata?: {
    stage?: string;
    filePath?: string;
    language?: string;
    isStreaming?: boolean;
    agentName?: string;
    toolName?: string;
    errorType?: string;
  };
}

export interface FileNode {
  id: string;
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileNode[];
  content?: string;
}

interface ChatViewProps {
  jobId: string;
  initialMessages?: ChatMessageData[];
  initialFiles?: FileNode[];
  currentStage: string;
  completedStages: string[];
  status: string;
  onSendMessage: (message: string) => void;
  onFileSelect?: (file: FileNode) => void;
}

export function ChatView({
  jobId,
  initialMessages = [],
  initialFiles = [],
  currentStage,
  completedStages,
  status,
  onSendMessage,
  onFileSelect,
}: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessageData[]>(initialMessages);
  const [files, setFiles] = useState<FileNode[]>(initialFiles);
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [filePanelOpen, setFilePanelOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleFileSelect = (file: FileNode) => {
    setSelectedFile(file);
    onFileSelect?.(file);
  };

  return (
    <div className="flex h-full">
      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <h2 className="text-lg font-medium text-gray-900 mb-2">What would you like to build?</h2>
              <p className="text-sm text-gray-500 max-w-sm">
                Describe the environment you want to build and watch as Eden generates the code in real-time.
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                type={msg.type}
                content={msg.content}
                metadata={msg.metadata}
              />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <ChatInput
          onSend={onSendMessage}
          disabled={status === "running"}
        />
      </div>

      {/* File panel */}
      {filePanelOpen && (
        <div className="w-80 bg-[var(--surface)] border-l border-[var(--border)] flex flex-col">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Files</h2>
            <button
              onClick={() => setFilePanelOpen(false)}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {files.length > 0 ? (
              <FileTree files={files} onFileSelect={handleFileSelect} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full px-4 text-center">
                <div className="w-12 h-12 bg-gray-50 rounded-xl flex items-center justify-center mb-3">
                  <svg className="w-6 h-6 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                </div>
                <p className="text-xs text-gray-500">
                  Files will appear here once created
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toggle file panel button */}
      {!filePanelOpen && (
        <button
          onClick={() => setFilePanelOpen(true)}
          className="absolute right-4 top-1/2 -translate-y-1/2 w-8 h-16 bg-white border border-gray-200 rounded-l-lg flex items-center justify-center shadow-md hover:bg-gray-50 transition-colors"
        >
          <ChevronLeft className="w-4 h-4 text-gray-500" />
        </button>
      )}
    </div>
  );
}