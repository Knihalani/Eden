"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useJobStream } from "@/hooks/use-job-stream";
import { ChatView, ChatMessageData, FileNode } from "@/components/chat/chat-view";
import { TestResultsPanel } from "@/components/environment/test-results-panel";
import { VersionHistory } from "@/components/environment/version-history";
import { VersionDiff } from "@/components/environment/version-diff";
import { PIPELINE_STAGES, STAGE_LABELS, STATUS_COLORS, OUTCOME_COLORS } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  MoreHorizontal,
  Copy,
  FileText,
  Download,
  Share2,
  X,
  Clock,
  Package,
  Hash,
  FileStack,
  Calendar,
  PanelRightClose,
  CheckCircle2,
  XCircle,
} from "lucide-react";

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

interface StreamMessage {
  type: string;
  data?: Record<string, unknown>;
}

interface ActionMenuProps {
  jobId: string;
  onCancel?: () => void;
}

function ActionMenu({ jobId, onCancel }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopyId = async () => {
    await navigator.clipboard.writeText(jobId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = async () => {
    const url = window.location.href;
    if (navigator.share) {
      await navigator.share({ url });
    } else {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
      >
        <MoreHorizontal className="w-5 h-5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-xl shadow-lg z-20 py-1">
            <button
              onClick={handleCopyId}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              {copied ? <Copy className="w-4 h-4 text-green-500" /> : <Hash className="w-4 h-4" />}
              {copied ? "Copied!" : "Copy Job ID"}
            </button>
            <button
              onClick={handleShare}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <Share2 className="w-4 h-4" />
              Share Link
            </button>
            <button
              onClick={() => window.open(`/api/jobs/${jobId}/logs`, "_blank")}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <FileText className="w-4 h-4" />
              View Logs
            </button>
            <button
              onClick={() => window.open(`/api/jobs/${jobId}/download`, "_blank")}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <Download className="w-4 h-4" />
              Download
            </button>
            <hr className="my-1 border-gray-100" />
            <button
              onClick={() => {
                if (onCancel) onCancel();
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              <X className="w-4 h-4" />
              Cancel Job
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface TimelineViewProps {
  stageHistory: Array<{ from?: string; to: string; at: string }>;
}

function TimelineView({ stageHistory }: TimelineViewProps) {
  if (!stageHistory || stageHistory.length === 0) return null;

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Stage Timeline</h3>
      <div className="relative">
        <div className="absolute left-3 top-0 bottom-0 w-px bg-gray-200" />
        <div className="space-y-4">
          {stageHistory.map((entry, index) => (
            <div key={index} className="relative flex items-start gap-3 pl-8">
              <div className="absolute left-2 w-2 h-2 rounded-full bg-blue-500 border-2 border-white ring-2 ring-blue-100" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">
                    {STAGE_LABELS[entry.to] || entry.to}
                  </span>
                </div>
                {entry.from && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    from {STAGE_LABELS[entry.from] || entry.from}
                  </p>
                )}
                <p className="text-xs text-gray-400 mt-0.5">{formatDate(entry.at)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
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
  const [metadataPanelOpen, setMetadataPanelOpen] = useState(true);
  const [showTestResults, setShowTestResults] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [versions, setVersions] = useState<Array<{ iteration: number; code: string; timestamp: string; trigger?: string }>>([]);
  const [selectedVersion, setSelectedVersion] = useState<{ iteration: number; code: string; timestamp: string } | null>(null);

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
      }
    },
    onMessage: (text) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.type === "system" && last.metadata?.isStreaming) {
          return prev.map((m, i) =>
            i === prev.length - 1
              ? { ...m, content: m.content + text }
              : m
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
    },
    onStageChange: (stage) => {
      updateMessages("stage-update", "", { stage });
      setCurrentStage(stage);
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
    },
    onCodeFragment: (code, filePath) => {
      setFiles((prev) => {
        const updated = prev.map((f) => {
          if (f.path === filePath && f.content !== undefined) {
            return { ...f, content: f.content + code };
          }
          if (f.children) {
            return { ...f, children: findAndUpdate(f.children, filePath, code) };
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
    },
    onComplete: () => {
      setMessages((prev) =>
        prev.map((m) =>
          m.metadata?.isStreaming ? { ...m, metadata: { ...m.metadata, isStreaming: false } } : m
        )
      );
      fetchJob();
      fetchJobResult();
    },
    onError: (error) => {
      updateMessages("system", `Error: ${error}`);
    },
    onAgentMessage: (content, agentName) => {
      updateMessages("agent", content, { agentName });
    },
    onToolCall: (toolName, content) => {
      updateMessages("tool-call", content, { toolName });
    },
    onWarning: (text) => {
      updateMessages("warning", text);
    },
    onErrorMessage: (content, errorType) => {
      updateMessages("error", content, { errorType });
    },
    onCodeGenMessage: (content) => {
      updateMessages("code-fragment", content);
    },
    onEdpPreview: (content) => {
      updateMessages("edp-preview", content);
    },
  });

  function findAndUpdate(nodes: FileNode[], path: string, code: string): FileNode[] {
    return nodes.map((n) => {
      if (n.path === path && n.content !== undefined) {
        return { ...n, content: n.content + code };
      }
      if (n.children) {
        return { ...n, children: findAndUpdate(n.children, path, code) };
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
        setTestResult(data.test_results as Record<string, unknown> | null);
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

  useEffect(() => {
    fetchJob();
    fetchVersions();
  }, [jobId]);

  const handleSendMessage = async (message: string) => {
    updateMessages("user", message);
    try {
      const res = await fetch(`/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: message,
          tags: [],
          framework: "gymnasium",
          framework_version: "0.29",
          difficulty_parameters: {},
          output_mode: "gymnasium_mode",
        }),
      });
      if (!res.ok) throw new Error("Failed to send message");
    } catch (e) {
      console.error(e);
      updateMessages("system", "Failed to send message. Please try again.");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-gray-500 mb-4">Job not found</p>
          <button
            onClick={() => router.push("/jobs")}
            className="text-sm text-blue-600 hover:underline"
          >
            Back to Jobs
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Breadcrumbs */}
      <div className="px-6 py-3 bg-white border-b border-gray-100 flex items-center gap-2 text-sm">
        <Link href="/" className="text-gray-500 hover:text-gray-700 transition-colors">
          Home
        </Link>
        <ChevronRight className="w-4 h-4 text-gray-400" />
        <Link href="/jobs" className="text-gray-500 hover:text-gray-700 transition-colors">
          Jobs
        </Link>
        <ChevronRight className="w-4 h-4 text-gray-400" />
        <span className="text-gray-900 font-medium">#{jobId}</span>
      </div>

      {/* Sticky Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100">
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-semibold text-gray-900">
              Job #{jobId.slice(0, 8)}
            </h1>
            <span className={cn(
              "inline-flex items-center gap-1.5 rounded-full font-medium px-3 py-1 text-sm",
              STATUS_COLORS[job.status] || "bg-gray-100 text-gray-800"
            )}>
              {STAGE_LABELS[job.status] || job.status}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ActionMenu jobId={jobId} />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Chat View */}
        <div className="flex-1">
          <ChatView
            jobId={jobId}
            initialMessages={messages}
            initialFiles={files}
            currentStage={currentStage}
            completedStages={completedStages}
            status={job.status}
            onSendMessage={handleSendMessage}
          />
        </div>

        {/* Metadata Panel */}
        {metadataPanelOpen && (
        <div className={cn(
          "w-80 bg-white border-l border-gray-100 flex flex-col transition-all duration-300",
        )}>
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Job Details</h2>
            <button
              onClick={() => setMetadataPanelOpen(!metadataPanelOpen)}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {/* Created Date */}
            <div className="flex items-start gap-3">
              <div className="p-2 bg-gray-50 rounded-lg">
                <Calendar className="w-4 h-4 text-gray-500" />
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Created</p>
                <p className="text-sm font-medium text-gray-900">
                  {new Date(job.created_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            </div>

            {/* Framework */}
            <div className="flex items-start gap-3">
              <div className="p-2 bg-gray-50 rounded-lg">
                <Package className="w-4 h-4 text-gray-500" />
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Framework</p>
                <p className="text-sm font-medium text-gray-900">
                  {job.framework || "gymnasium"}
                </p>
                <p className="text-xs text-gray-500">
                  v{job.framework_version || "0.29"}
                </p>
              </div>
            </div>

            {/* Duration */}
            <div className="flex items-start gap-3">
              <div className="p-2 bg-gray-50 rounded-lg">
                <Clock className="w-4 h-4 text-gray-500" />
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Duration</p>
                <p className="text-sm font-medium text-gray-900">
                  {job.duration
                    ? job.duration > 60
                      ? `${Math.floor(job.duration / 60)}m ${job.duration % 60}s`
                      : `${job.duration}s`
                    : "In progress..."}
                </p>
              </div>
            </div>

            {/* File Count */}
            <div className="flex items-start gap-3">
              <div className="p-2 bg-gray-50 rounded-lg">
                <FileStack className="w-4 h-4 text-gray-500" />
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Files</p>
                <p className="text-sm font-medium text-gray-900">
                  {job.file_count ?? files.length}
                </p>
              </div>
            </div>

            {/* Timeline for completed jobs */}
            {job.status === "completed" && job.stage_history && job.stage_history.length > 0 && (
              <TimelineView stageHistory={job.stage_history} />
            )}

            {/* Outcome Tier */}
            {job.outcome_tier && (
              <div className="p-3 bg-gray-50 rounded-xl">
                <p className="text-xs text-gray-500 mb-1">Outcome</p>
                <span className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border",
                  OUTCOME_COLORS[job.outcome_tier] || "bg-gray-100 text-gray-700 border-gray-300"
                )}>
                  {job.outcome_tier.charAt(0).toUpperCase() + job.outcome_tier.slice(1)}
                </span>
              </div>
            )}

            {/* Test Results toggle - show for completed jobs */}
            {(job.status === "completed" || job.status === "failed") && (
              <button
                onClick={() => {
                  if (!showTestResults) fetchJobResult();
                  setShowTestResults(!showTestResults);
                }}
                className={cn(
                  "w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-colors",
                  showTestResults
                    ? "bg-blue-50 border-blue-200"
                    : "bg-gray-50 border-gray-200 hover:border-blue-200 hover:bg-blue-50"
                )}
              >
                <div className="flex items-center gap-2">
                  {job.status === "completed" ? (
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-600" />
                  )}
                  <span className="text-sm font-medium text-gray-900">Test Results</span>
                </div>
                <span className={cn(
                  "text-xs px-1.5 py-0.5 rounded-full font-medium",
                  job.status === "completed"
                    ? "bg-green-100 text-green-700"
                    : "bg-red-100 text-red-700"
                )}>
                  {job.status === "completed" ? "PASSED" : "FAILED"}
                </span>
              </button>
            )}

            {/* Test Results Panel */}
            {showTestResults && testResult && (
              <div className="mt-2">
                <TestResultsPanel testResults={testResult as Parameters<typeof TestResultsPanel>[0]["testResults"]} />
              </div>
            )}

            {/* Version History for completed jobs */}
            {job.status === "completed" && versions.length > 0 && (
              <VersionHistory
                jobId={jobId}
                versions={versions}
                selectedIteration={selectedVersion?.iteration}
                onSelectVersion={(v) => setSelectedVersion(v)}
              />
            )}

            {/* Version Diff when two versions selected */}
            {selectedVersion && versions.length >= 2 && (
              <VersionDiff
                oldVersion={versions[versions.length - 2]}
                newVersion={selectedVersion}
              />
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}