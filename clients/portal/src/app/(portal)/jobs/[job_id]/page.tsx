"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useJobStream } from "@/hooks/use-job-stream";
import { ChatMessage } from "@/components/chat/chat-message";
import { ChatInput } from "@/components/chat/chat-input";
import { FileTree, FileNode } from "@/components/files/file-tree";
import { CodeViewer } from "@/components/files/code-viewer";
import { ChatMessageData } from "@/components/chat/chat-view";
import { PIPELINE_STAGES, STAGE_LABELS, STATUS_COLORS, OUTCOME_COLORS } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  X,
  Download,
  RotateCcw,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  FileCode,
  Loader2,
  Minimize2,
  Maximize2,
  ListTree,
} from "lucide-react";
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
} from "lucide-react";

interface ActivityLogEntry {
  id: string;
  timestamp: Date;
  text: string;
  type: "message" | "stage" | "tool" | "file" | "warning" | "error";
}

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
  planning: "text-indigo-500 bg-indigo-50",
  criticizing: "text-amber-500 bg-amber-50",
  refining: "text-cyan-500 bg-cyan-50",
  fact_checking: "text-teal-500 bg-teal-50",
  executing: "text-blue-500 bg-blue-50",
  code_quality: "text-violet-500 bg-violet-50",
  verifying: "text-emerald-500 bg-emerald-50",
  testing: "text-lime-500 bg-lime-50",
  archiving: "text-purple-500 bg-purple-50",
};

const STAGE_LINE_COLORS: Record<string, string> = {
  planning: "bg-indigo-300",
  criticizing: "bg-amber-300",
  refining: "bg-cyan-300",
  fact_checking: "bg-teal-300",
  executing: "bg-blue-300",
  code_quality: "bg-violet-300",
  verifying: "bg-emerald-300",
  testing: "bg-lime-300",
  archiving: "bg-purple-300",
};

const STAGE_COMPLETED_COLORS: Record<string, string> = {
  planning: "bg-indigo-500 text-white",
  criticizing: "bg-amber-500 text-white",
  refining: "bg-cyan-500 text-white",
  fact_checking: "bg-teal-500 text-white",
  executing: "bg-blue-500 text-white",
  code_quality: "bg-violet-500 text-white",
  verifying: "bg-emerald-500 text-white",
  testing: "bg-lime-500 text-white",
  archiving: "bg-purple-500 text-white",
};

interface PlanApproval {
  plan: string;
  require_approval: boolean;
  feedback?: string;
}

interface JobStatus {
  job_id: string;
  status: string;
  current_stage: string;
  outcome_tier: string | null;
  created_at: string;
  updated_at: string;
  stage_history: Array<{ from?: string; to: string; at: string }>;
  framework?: string;
  framework_version?: string;
  duration?: number;
  file_count?: number;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

export default function JobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params.job_id as string;

  const [job, setJob] = useState<JobStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentStage, setCurrentStage] = useState("planning");
  const [completedStages, setCompletedStages] = useState<string[]>([]);
  const [failedStages, setFailedStages] = useState<string[]>([]);
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
  const [chatPanelCollapsed, setChatPanelCollapsed] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<"files" | "activity">("files");
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [selectedFileContent, setSelectedFileContent] = useState<string | null>(null);
  const [planApproval, setPlanApproval] = useState<PlanApproval | null>(null);
  const [versions, setVersions] = useState<Array<{ iteration: number; code: string; timestamp: string; trigger?: string }>>([]);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const messagesEndRef = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      node.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  const addActivity = useCallback((text: string, type: ActivityLogEntry["type"]) => {
    setActivityLog((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, timestamp: new Date(), text, type },
    ]);
  }, []);

  const updateMessages = useCallback((type: ChatMessageData["type"], content: string, metadata?: ChatMessageData["metadata"]) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type,
        content,
        metadata,
      },
    ]);
  }, []);

  const handleFileSelect = (file: FileNode) => {
    setSelectedFile(file);
    setSelectedFileContent(file.content || null);
  };

  useJobStream(jobId, {
    onStatus: (data) => {
      setJob((prev) => (prev ? { ...prev, ...data } : null));
      if (data.current_stage && data.current_stage !== currentStage) {
        const prevIndex = PIPELINE_STAGES.indexOf(currentStage as typeof PIPELINE_STAGES[number]);
        const newIndex = PIPELINE_STAGES.indexOf(data.current_stage as typeof PIPELINE_STAGES[number]);
        if (newIndex > prevIndex) {
          setCompletedStages((prev) =>
            prev.includes(currentStage) ? prev : [...prev, currentStage]
          );
        }
        setCurrentStage(data.current_stage);
        addActivity(`Stage changed to ${STAGE_LABELS[data.current_stage] || data.current_stage}`, "stage");
      }
    },
    onMessage: (text) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.type === "system" && last.metadata?.isStreaming) {
          return prev.map((m, i) =>
            i === prev.length - 1 ? { ...m, content: m.content + text } : m
          );
        }
        return [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            type: "system",
            content: text,
            metadata: { isStreaming: true },
          },
        ];
      });
      addActivity(text, "message");
    },
    onStageChange: (stage) => {
      updateMessages("stage-update", "", { stage });
      setCurrentStage(stage);
      addActivity(`Started stage: ${STAGE_LABELS[stage] || stage}`, "stage");
    },
    onFileCreated: (file) => {
      setFiles((prev) => {
        const parts = file.path.split("/");
        let current = prev;
        for (let i = 0; i < parts.length - 1; i++) {
          const dirName = parts[i];
          let folder = current.find((f) => f.name === dirName && f.type === "folder");
          if (!folder) {
            folder = {
              id: `folder-${parts.slice(0, i + 1).join("-")}`,
              name: dirName,
              path: parts.slice(0, i + 1).join("/"),
              type: "folder",
              children: [],
            };
            current.push(folder);
          }
          if (!folder.children) folder.children = [];
          current = folder.children;
        }
        const fileNode: FileNode = {
          id: `file-${file.path.replace(/\//g, "-")}`,
          name: parts[parts.length - 1],
          path: file.path,
          type: "file",
          content: file.content || "",
        };
        current.push(fileNode);
        return [...prev];
      });
      updateMessages("file-reference", file.path, { filePath: file.path });
      addActivity(`Created file: ${file.path}`, "file");
    },
    onCodeFragment: (code, filePath) => {
      setFiles((prev) => {
        const updated = prev.map((f) => {
          if (f.path === filePath && f.content !== undefined) {
            return { ...f, content: f.content + code };
          }
          if (f.children) {
            return { ...f, children: findAndUpdateFile(f.children, filePath, code) };
          }
          return f;
        });
        return updated;
      });
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.type === "code-block" && last.metadata?.filePath === filePath && last.metadata?.isStreaming) {
          return prev.map((m, i) =>
            i === prev.length - 1 ? { ...m, content: m.content + code } : m
          );
        }
        return [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            type: "code-block",
            content: code,
            metadata: { filePath, isStreaming: true },
          },
        ];
      });
      if (selectedFile?.path === filePath) {
        setSelectedFileContent((prev) => (prev || "") + code);
      }
    },
    onComplete: () => {
      setMessages((prev) =>
        prev.map((m) =>
          m.metadata?.isStreaming ? { ...m, metadata: { ...m.metadata, isStreaming: false } } : m
        )
      );
      addActivity("Job completed", "message");
      fetchJob();
      fetchJobResult();
    },
    onError: (error) => {
      updateMessages("system", `Error: ${error}`);
      addActivity(`Error: ${error}`, "error");
    },
    onAgentMessage: (content, agentName) => {
      updateMessages("agent", content, { agentName });
      addActivity(`${agentName || "Agent"}: ${content}`, "message");
    },
    onToolCall: (toolName, content) => {
      updateMessages("tool-call", content, { toolName });
      addActivity(`Tool ${toolName}: ${content}`, "tool");
    },
    onWarning: (text) => {
      updateMessages("warning", text);
      addActivity(`Warning: ${text}`, "warning");
    },
    onErrorMessage: (content, errorType) => {
      updateMessages("error", content, { errorType });
      addActivity(`Error (${errorType}): ${content}`, "error");
    },
    onCodeGenMessage: (content) => {
      updateMessages("code-fragment", content);
    },
    onEdpPreview: (content) => {
      updateMessages("edp-preview", content);
    },
  });

  function findAndUpdateFile(nodes: FileNode[], path: string, code: string): FileNode[] {
    return nodes.map((n) => {
      if (n.path === path && n.content !== undefined) {
        return { ...n, content: n.content + code };
      }
      if (n.children) {
        return { ...n, children: findAndUpdateFile(n.children, path, code) };
      }
      return n;
    });
  }

  async function fetchJob() {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (res.ok) {
        const data = await res.json();
        setJob(data);
        setCurrentStage(data.current_stage);
        const completed: string[] = [];
        for (let i = 0; i < PIPELINE_STAGES.length; i++) {
          if (PIPELINE_STAGES[i] === data.current_stage) break;
          completed.push(PIPELINE_STAGES[i]);
        }
        setCompletedStages(completed);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function fetchJobResult() {
    try {
      const res = await fetch(`/api/jobs/${jobId}/result`);
      if (res.ok) {
        const data = await res.json();
        if (job?.status === "human_review" && data.plan) {
          setPlanApproval({ plan: data.plan, require_approval: true });
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchVersions() {
    try {
      const res = await fetch(`/api/jobs/${jobId}/versions`);
      if (res.ok) {
        const data = await res.json();
        setVersions(data);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function handleCancelJob() {
    try {
      const res = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
      if (res.ok) {
        addActivity("Job cancelled by user", "message");
        fetchJob();
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function handleApprovePlan() {
    try {
      const res = await fetch(`/api/jobs/${jobId}/approve`, { method: "POST" });
      if (res.ok) {
        setPlanApproval(null);
        addActivity("Plan approved, continuing execution", "message");
        fetchJob();
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function handleRejectPlan() {
    try {
      const res = await fetch(`/api/jobs/${jobId}/reject`, { method: "POST" });
      if (res.ok) {
        setPlanApproval(null);
        addActivity("Plan rejected", "message");
      }
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    fetchJob();
    fetchVersions();
  }, [jobId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-[var(--background)]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-[var(--text-secondary)]">Loading...</p>
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex items-center justify-center h-full bg-[var(--background)]">
        <div className="text-center">
          <p className="text-[var(--text-secondary)] mb-4">Job not found</p>
          <button
            onClick={() => router.push("/jobs")}
            className="text-sm text-[var(--accent)] hover:underline"
          >
            Back to Jobs
          </button>
        </div>
      </div>
    );
  }

  const isRunning = job.status === "running" || job.status === "pending";
  const isComplete = job.status === "completed";
  const isHumanReview = job.status === "human_review";

  return (
    <div className="flex flex-col h-full bg-[var(--background)]">
      {/* Top Bar */}
      <div className="h-14 bg-[var(--surface)] border-b border-[var(--border)] flex items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <Link href="/jobs" className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <ChevronRight className="w-5 h-5 rotate-180" />
          </Link>
          <span className="text-sm font-mono text-[var(--text-secondary)]">#</span>
          <span className="text-sm font-semibold text-[var(--text-primary)] font-mono">{jobId.slice(0, 8)}</span>
          <span className={cn(
            "inline-flex items-center gap-1.5 rounded-full font-medium px-2.5 py-0.5 text-xs",
            STATUS_COLORS[job.status] || "bg-gray-100 text-gray-800"
          )}>
            {STAGE_LABELS[job.status] || job.status}
          </span>
          {job.outcome_tier && (
            <span className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border",
              OUTCOME_COLORS[job.outcome_tier] || "bg-gray-100 text-gray-700 border-gray-300"
            )}>
              {job.outcome_tier.charAt(0).toUpperCase() + job.outcome_tier.slice(1)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isRunning && (
            <button
              onClick={handleCancelJob}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
          )}
          {isComplete && (
            <a
              href={`/api/jobs/${jobId}/download`}
              download
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--accent-bg)] rounded-lg transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </a>
          )}
        </div>
      </div>

      {/* Main Content - Split View */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Side - Chat (60%) */}
        {!chatPanelCollapsed ? (
          <div className="flex-1 flex flex-col min-w-0 border-r border-[var(--border)]">
            {/* Stage Progress Bar */}
            <div className="h-12 bg-[var(--surface)] border-b border-[var(--border)] px-4 flex items-center gap-4 overflow-x-auto">
              <div className="flex items-center gap-1 flex-shrink-0">
                {PIPELINE_STAGES.map((stage, index) => {
                  const Icon = STAGE_ICONS[stage];
                  const isComplete = completedStages.includes(stage);
                  const isFailed = failedStages.some(s => s === stage);
                  const isActive = stage === currentStage && !isComplete && !isFailed;
                  const isPending = !isComplete && !isActive && !isFailed;

                  return (
                    <div key={stage} className="flex items-center">
                      <div
                        className={cn(
                          "w-8 h-8 rounded-lg flex items-center justify-center transition-all",
                          isComplete && STAGE_COMPLETED_COLORS[stage],
                          isActive && cn(STAGE_COLORS[stage], "stage-active ring-2 ring-offset-1 ring-[var(--accent)]"),
                          isPending && "bg-[var(--surface)] text-[var(--text-muted)]",
                          isFailed && "bg-red-100 text-red-500"
                        )}
                        title={STAGE_LABELS[stage]}
                      >
                        {isComplete ? (
                          <CheckCircle className="w-4 h-4 text-white" />
                        ) : isFailed ? (
                          <XCircle className="w-4 h-4" />
                        ) : (
                          <Icon className="w-4 h-4" />
                        )}
                      </div>
                      {index < PIPELINE_STAGES.length - 1 && (
                        <div
                          className={cn(
                            "w-4 h-0.5 mx-0.5",
                            isComplete ? STAGE_LINE_COLORS[stage] : "bg-[var(--border)]"
                          )}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="flex-1" />
              <button
                onClick={() => setChatPanelCollapsed(true)}
                className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)] rounded-lg transition-colors"
                title="Minimize chat"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            </div>

            {/* Stage Label */}
            <div className="h-10 bg-[var(--accent-bg)] border-b border-[var(--border)] px-4 flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--accent)]">
                {STAGE_LABELS[currentStage] || currentStage}
              </span>
              {isRunning && (
                <span className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-[var(--accent)] rounded-full animate-bounce [animation-delay:300ms]" />
                </span>
              )}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <div className="w-16 h-16 bg-[var(--accent-bg)] rounded-2xl flex items-center justify-center mb-4">
                    <Loader2 className="w-8 h-8 text-[var(--accent)] animate-spin" />
                  </div>
                  <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Job in Progress</h2>
                  <p className="text-sm text-[var(--text-secondary)] max-w-sm">
                    Monitoring job execution. Messages and files will appear here as they are generated.
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
              onSend={() => {}}
              disabled={true}
              placeholder="Chat disabled during job execution..."
            />
          </div>
        ) : (
          <div className="w-12 bg-[var(--surface)] border-r border-[var(--border)] flex flex-col items-center py-4 gap-2">
            <button
              onClick={() => setChatPanelCollapsed(false)}
              className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--accent-bg)] rounded-lg transition-colors"
              title="Expand chat"
            >
              <Maximize2 className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* Right Side - Multi-section Pane (40%) */}
        {chatPanelCollapsed ? (
          <div className="flex-1" />
        ) : (
          <div className="w-[400px] flex flex-col bg-[var(--surface)]">
            {/* Tab Switcher */}
            <div className="h-11 border-b border-[var(--border)] flex">
              <button
                onClick={() => setRightPanelTab("files")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 text-sm font-medium transition-colors border-b-2 -mb-[1px]",
                  rightPanelTab === "files"
                    ? "text-[var(--accent)] border-[var(--accent)]"
                    : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]"
                )}
              >
                <ListTree className="w-4 h-4" />
                Files
              </button>
              <button
                onClick={() => setRightPanelTab("activity")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 text-sm font-medium transition-colors border-b-2 -mb-[1px]",
                  rightPanelTab === "activity"
                    ? "text-[var(--accent)] border-[var(--accent)]"
                    : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]"
                )}
              >
                <Clock className="w-4 h-4" />
                Activity
              </button>
            </div>

            {/* Content */}
            {rightPanelTab === "files" ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* File Tree */}
                <div className="h-1/2 overflow-y-auto border-b border-[var(--border)] p-3">
                  {files.length > 0 ? (
                    <FileTree files={files} onFileSelect={handleFileSelect} selectedFileId={selectedFile?.id} />
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-center">
                      <div className="w-12 h-12 bg-[var(--bg-muted)] rounded-xl flex items-center justify-center mb-3">
                        <FileCode className="w-6 h-6 text-[var(--text-muted)]" />
                      </div>
                      <p className="text-xs text-[var(--text-muted)]">
                        Files will appear here once created
                      </p>
                    </div>
                  )}
                </div>

                {/* Code Preview */}
                <div className="h-1/2 overflow-hidden">
                  {selectedFile ? (
                    <CodeViewer
                      filePath={selectedFile.path}
                      content={selectedFileContent || selectedFile.content}
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-center p-4">
                      <div className="w-12 h-12 bg-[var(--bg-muted)] rounded-xl flex items-center justify-center mb-3">
                        <FileCode className="w-6 h-6 text-[var(--text-muted)]" />
                      </div>
                      <p className="text-xs text-[var(--text-muted)]">Select a file to preview</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-3 space-y-1">
                {activityLog.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <div className="w-12 h-12 bg-[var(--bg-muted)] rounded-xl flex items-center justify-center mb-3">
                      <Clock className="w-6 h-6 text-[var(--text-muted)]" />
                    </div>
                    <p className="text-xs text-[var(--text-muted)]">No activity yet</p>
                  </div>
                ) : (
                  activityLog.map((entry) => (
                    <div
                      key={entry.id}
                      className={cn(
                        "flex items-start gap-2 py-2 px-2 rounded-lg",
                        entry.type === "warning" && "bg-amber-50",
                        entry.type === "error" && "bg-red-50"
                      )}
                    >
                      <span className="text-[10px] font-mono text-[var(--text-muted)] mt-0.5 flex-shrink-0">
                        {formatTime(entry.timestamp)}
                      </span>
                      <span className={cn(
                        "text-xs",
                        entry.type === "stage" && "text-indigo-600 font-medium",
                        entry.type === "tool" && "text-amber-600",
                        entry.type === "warning" && "text-amber-700",
                        entry.type === "error" && "text-red-700",
                        entry.type === "message" && "text-[var(--text-primary)]",
                        entry.type === "file" && "text-emerald-600"
                      )}>
                        {entry.text}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Plans/Approvals Section */}
            {isHumanReview && planApproval && (
              <div className="border-t border-[var(--border)] p-4 bg-amber-50">
                <div className="flex items-center gap-2 mb-3">
                  <AlertCircle className="w-5 h-5 text-amber-600" />
                  <span className="text-sm font-semibold text-amber-900">Human Review Required</span>
                </div>
                <div className="bg-white rounded-lg p-3 mb-3 max-h-32 overflow-y-auto">
                  <p className="text-xs text-gray-700 whitespace-pre-wrap">{planApproval.plan}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleApprovePlan}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    Approve
                  </button>
                  <button
                    onClick={handleRejectPlan}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
                  >
                    <XCircle className="w-4 h-4" />
                    Reject
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Bar */}
      <div className="h-10 bg-[var(--surface)] border-t border-[var(--border)] flex items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowVersionHistory(!showVersionHistory)}
            className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Version History
            {versions.length > 0 && (
              <span className="px-1.5 py-0.5 bg-[var(--bg-muted)] rounded text-[10px] font-medium">
                {versions.length}
              </span>
            )}
          </button>
        </div>
        {job.duration && (
          <span className="text-xs text-[var(--text-muted)]">
            Duration: {job.duration > 60 ? `${Math.floor(job.duration / 60)}m ${job.duration % 60}s` : `${job.duration}s`}
          </span>
        )}
      </div>

      {/* Version History Dropdown */}
      {showVersionHistory && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 w-80 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-lg overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <span className="text-sm font-semibold text-[var(--text-primary)]">Version History</span>
            <button onClick={() => setShowVersionHistory(false)} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {versions.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-[var(--text-muted)]">
                No versions available
              </div>
            ) : (
              versions.map((version) => (
                <div
                  key={version.iteration}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-[var(--accent-bg)] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono px-1.5 py-0.5 bg-[var(--bg-muted)] rounded text-[var(--text-secondary)]">
                      v{version.iteration}
                    </span>
                    <span className="text-sm text-[var(--text-primary)]">
                      {version.trigger || "executor"}
                    </span>
                  </div>
                  <span className="text-xs text-[var(--text-muted)]">
                    {version.timestamp ? new Date(version.timestamp).toLocaleString() : "—"}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
