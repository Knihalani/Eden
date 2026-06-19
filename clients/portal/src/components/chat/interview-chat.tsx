"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { ChatInput } from "./chat-input";
import { ChecklistSidebar } from "./checklist-sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Sparkles,
  Loader2,
  CheckCircle2,
  ArrowRight,
  RotateCcw,
  AlertCircle,
  User,
  Zap,
  ClipboardList,
  ChevronRight,
  FileText,
  Menu,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChecklistState,
  GeneratedSpec,
  InterviewPhase,
} from "@/lib/types";

// ─── Types ───

interface ChatMessage {
  id: string;
  type: "user" | "assistant" | "system" | "spec" | "error";
  content: string;
  timestamp: Date;
  metadata?: {
    extracted_fields?: string[];
    readiness_score?: number;
  };
}

// ─── Constants ───

const SUGGESTED_PROMPTS = [
  "A web automation sandbox where agents browse and interact with websites",
  "A multi-agent coordination environment for task delegation",
  "An evaluation benchmark for code editing agents",
  "A tool-use testing environment for LLM agents with memory",
];

const QUICK_CREATE_DIFFICULTY = "intermediate";

// ─── Helpers ───

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(date: Date) {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// ─── Component ───

export function InterviewChat() {
  const router = useRouter();

  // Session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [checklistState, setChecklistState] = useState<ChecklistState | null>(null);
  const [phase, setPhase] = useState<InterviewPhase>("interviewing");
  const [isReadyForSpec, setIsReadyForSpec] = useState(false);
  const [readinessScore, setReadinessScore] = useState(0);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Spec state
  const [generatedSpec, setGeneratedSpec] = useState<GeneratedSpec | null>(null);
  const [specId, setSpecId] = useState<string | null>(null);
  const [showSpecReview, setShowSpecReview] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, scrollToBottom]);

  // Close mobile drawer on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && drawerOpen) {
        setDrawerOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [drawerOpen]);

  // ─── Send message ───
  const handleSendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isLoading) return;

      // Add user message
      const userMessage: ChatMessage = {
        id: generateId(),
        type: "user",
        content: content.trim(),
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

      try {
        const response = await api.submitInterviewTurn({
          session_id: sessionId ?? undefined,
          message: content.trim(),
        });

        // Update session state
        setSessionId(response.session_id);
        setChecklistState(response.checklist_state);
        setIsReadyForSpec(response.is_ready_for_spec);
        setReadinessScore(response.readiness_score);

        if (response.is_complete) {
          setPhase("reviewing_spec");
        }

        // Add assistant message
        const assistantMessage: ChatMessage = {
          id: generateId(),
          type: "assistant",
          content: response.assistant_message,
          timestamp: new Date(),
          metadata: {
            extracted_fields: response.extracted_fields,
            readiness_score: response.readiness_score,
          },
        };
        setMessages((prev) => [...prev, assistantMessage]);

        // If ready and assistant offered spec, add a system hint
        if (response.is_ready_for_spec && !response.is_complete) {
          const hintMessage: ChatMessage = {
            id: generateId(),
            type: "system",
            content: `Ready for spec generation (${Math.round(response.readiness_score * 100)}%). Click "Generate Spec" in the sidebar when you're satisfied.`,
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, hintMessage]);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to send message";
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            type: "error",
            content: msg,
            timestamp: new Date(),
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [sessionId, isLoading]
  );

  // ─── Generate Spec ───
  const handleGenerateSpec = useCallback(async () => {
    if (!sessionId) return;
    setPhase("generating_spec");
    setIsLoading(true);

    try {
      const response = await api.generateSpec(sessionId);
      setGeneratedSpec(response.spec_data);
      setSpecId(response.spec_id);
      setShowSpecReview(true);
      setPhase("reviewing_spec");

      // Add spec message to chat
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          type: "spec",
          content: `I've generated your environment spec. Review it below and approve to start building.`,
          timestamp: new Date(),
        },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to generate spec";
      setPhase("interviewing");
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          type: "error",
          content: msg,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  // ─── Regenerate Spec ───
  const handleRegenerateSpec = useCallback(async () => {
    if (!sessionId) return;
    setPhase("generating_spec");
    setIsLoading(true);

    try {
      const response = await api.regenerateSpec(sessionId);
      setGeneratedSpec(response.spec_data);
      setSpecId(response.spec_id);
      setPhase("reviewing_spec");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to regenerate spec";
      setPhase("reviewing_spec");
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  // ─── Approve Spec → Create Job ───
  const handleApproveSpec = useCallback(async () => {
    if (!specId) return;
    setPhase("creating_job");
    setIsLoading(true);
    setShowSpecReview(false);

    try {
      const response = await api.convertSpecToJob(specId);
      setPhase("job_created");
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          type: "system",
          content: `Environment job created! Redirecting to job details...`,
          timestamp: new Date(),
        },
      ]);
      // Navigate to job page after brief delay
      setTimeout(() => {
        router.push(`/jobs/${response.job_id}`);
      }, 800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create job";
      setPhase("reviewing_spec");
      setShowSpecReview(true);
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          type: "error",
          content: msg,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [specId, router]);

  // ─── Quick Create (skip interview) ───
  const handleQuickCreate = useCallback(async () => {
    if (messages.length === 0) {
      // User hasn't said anything yet, show a simple form or just redirect
      router.push("/jobs?quick_create=true");
      return;
    }

    // Extract description from first user message
    const firstUserMessage = messages.find((m) => m.type === "user");
    const description = firstUserMessage?.content ?? "Auto-generated environment";

    setPhase("creating_job");
    setIsLoading(true);

    try {
      const response = await api.submitJob({
        description,
        tags: [],
        difficulty_parameters: { level: QUICK_CREATE_DIFFICULTY },
      });
      router.push(`/jobs/${response.job_id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create job";
      setPhase("interviewing");
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          type: "error",
          content: msg,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [messages, router]);

  // ─── Render ───

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-0 h-full">
      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-[50vh] lg:min-h-0">
        {/* Header */}
        <div className="px-6 py-4 bg-[var(--bg-primary)] border-b border-[var(--border)] flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">
              Create Environment
            </h1>
            <p className="text-sm text-[var(--text-secondary)] mt-0.5">
              {phase === "interviewing" && "Tell me what you want to build"}
              {phase === "generating_spec" && "Generating your spec..."}
              {phase === "reviewing_spec" && "Review your environment spec"}
              {phase === "creating_job" && "Creating your environment..."}
              {phase === "job_created" && "Environment created!"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isReadyForSpec && phase === "interviewing" && (
              <Badge variant="success" className="hidden sm:inline-flex">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Ready for spec
              </Badge>
            )}
            <button
              onClick={() => setDrawerOpen(true)}
              className="lg:hidden p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
              aria-label="Open checklist"
            >
              <Menu className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div
          ref={chatContainerRef}
          className="flex-1 overflow-y-auto p-6 space-y-5"
        >
          {/* Empty State */}
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center -mt-8">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[var(--terminal)] flex items-center justify-center mb-6 shadow-lg">
                <Sparkles className="w-8 h-8 text-[var(--bg-base)]" />
              </div>
              <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-2 text-center">
                Tell me what you want to build
              </h2>
              <p className="text-[var(--text-secondary)] text-center mb-8 max-w-md">
                I will interview you to understand your needs, then generate a
                detailed spec before we start building.
              </p>

              <div className="flex flex-col gap-3 w-full max-w-lg">
                <p className="text-sm font-medium text-[var(--text-muted)] text-center">
                  Try one of these examples:
                </p>
                {SUGGESTED_PROMPTS.map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => handleSendMessage(prompt)}
                    disabled={isLoading}
                    className={cn(
                      "text-left px-5 py-3 bg-[var(--bg-primary)] border border-[var(--border)] rounded-xl",
                      "text-sm text-[var(--text-primary)] hover:border-[var(--accent)] hover:bg-[var(--accent-faint)]",
                      "transition-all duration-200 hover:shadow-sm disabled:opacity-50"
                    )}
                  >
                    {prompt}
                  </button>
                ))}
              </div>

              <div className="mt-8 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <ClipboardList className="w-3.5 h-3.5" />
                <span>
                  The interview covers 20 fields across 3 priority levels
                </span>
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {/* Loading indicator */}
          {isLoading && (
            <div className="flex gap-3 message-appear">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--terminal)] flex items-center justify-center flex-shrink-0">
                <Sparkles className="w-4 h-4 text-[var(--bg-base)]" />
              </div>
              <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-2xl rounded-bl-md px-4 py-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-[var(--accent)] animate-spin" />
                  <span className="text-sm text-[var(--text-muted)]">
                    {phase === "generating_spec"
                      ? "Generating your spec..."
                      : phase === "creating_job"
                      ? "Creating your environment..."
                      : "Thinking..."}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <ChatInput
          onSend={handleSendMessage}
          disabled={isLoading || phase === "generating_spec" || phase === "creating_job" || phase === "job_created"}
          placeholder={
            phase === "interviewing"
              ? "Describe your environment..."
              : phase === "reviewing_spec"
              ? "Ask to modify the spec or approve to continue..."
              : "Please wait..."
          }
        />
      </div>

      {/* Desktop Checklist Sidebar */}
      <div className="hidden lg:flex flex-shrink-0">
        <ChecklistSidebar
          checklistState={checklistState}
          phase={phase}
          isReadyForSpec={isReadyForSpec}
          readinessScore={readinessScore}
          onGenerateSpec={handleGenerateSpec}
          onSkipInterview={handleQuickCreate}
        />
      </div>

      {/* Mobile Checklist Drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            {/* Backdrop */}
            <motion.button
              key="drawer-backdrop"
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setDrawerOpen(false)}
              className="fixed inset-0 bg-[var(--overlay)] z-[45] lg:hidden border-0 p-0 cursor-default"
              aria-label="Close checklist drawer"
            />
            {/* Drawer Panel */}
            <motion.div
              key="drawer-panel"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed inset-y-0 right-0 w-[320px] max-w-[85vw] bg-[var(--bg-secondary)] border-l border-[var(--border)] z-50 lg:hidden flex flex-col shadow-xl"
            >
              <ChecklistSidebar
                checklistState={checklistState}
                phase={phase}
                isReadyForSpec={isReadyForSpec}
                readinessScore={readinessScore}
                onGenerateSpec={() => {
                  setDrawerOpen(false);
                  handleGenerateSpec();
                }}
                onSkipInterview={() => {
                  setDrawerOpen(false);
                  handleQuickCreate();
                }}
                onClose={() => setDrawerOpen(false)}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Spec Review Dialog */}
      <Dialog open={showSpecReview} onOpenChange={setShowSpecReview}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-[var(--accent)]" />
              Environment Spec Review
            </DialogTitle>
            <DialogDescription>
              Review the generated spec before creating your environment. You can
              go back to the interview to make changes.
            </DialogDescription>
          </DialogHeader>

          {generatedSpec && (
            <SpecReviewContent
              spec={generatedSpec}
              onApprove={handleApproveSpec}
              onRegenerate={handleRegenerateSpec}
              onEdit={() => {
                setShowSpecReview(false);
                setPhase("interviewing");
              }}
              isCreating={phase === "creating_job"}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Message Bubble ───

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.type === "user") {
    return (
      <div className="flex justify-end message-appear">
        <div className="flex flex-col items-end gap-1 max-w-[80%]">
          <div className="rounded-xl rounded-br-md bg-[var(--accent)] text-[var(--bg-base)] px-4 py-3">
            <p className="text-sm leading-relaxed">{message.content}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-muted)]">
              {formatTime(message.timestamp)}
            </span>
            <div className="w-6 h-6 rounded-full bg-[var(--accent-faint)] flex items-center justify-center">
              <User className="w-3 h-3 text-[var(--accent)]" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (message.type === "assistant") {
    return (
      <div className="flex gap-3 message-appear">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--terminal)] flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-4 h-4 text-[var(--bg-base)]" />
        </div>
        <div className="flex-1 min-w-0 max-w-[80%]">
          <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-2xl rounded-bl-md px-4 py-3">
            <p className="text-sm leading-relaxed text-[var(--text-primary)]">
              {message.content}
            </p>
            {message.metadata?.readiness_score !== undefined && (
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 bg-[var(--border-subtle)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[var(--accent)] rounded-full"
                    style={{
                      width: `${Math.min(message.metadata.readiness_score * 100, 100)}%`,
                    }}
                  />
                </div>
                <span className="text-[10px] text-[var(--text-muted)]">
                  {Math.round(message.metadata.readiness_score * 100)}%
                </span>
              </div>
            )}
          </div>
          <span className="text-xs text-[var(--text-muted)] mt-1 block">
            {formatTime(message.timestamp)}
          </span>
        </div>
      </div>
    );
  }

  if (message.type === "spec") {
    return (
      <div className="flex gap-3 message-appear">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--success)] to-[var(--terminal)] flex items-center justify-center flex-shrink-0">
          <CheckCircle2 className="w-4 h-4 text-[var(--bg-base)]" />
        </div>
        <div className="flex-1 min-w-0 max-w-[80%]">
          <div className="bg-[var(--success-bg)] border border-[var(--success)]/20 rounded-2xl rounded-bl-md px-4 py-3">
            <p className="text-sm leading-relaxed text-[var(--text-primary)]">
              {message.content}
            </p>
          </div>
          <span className="text-xs text-[var(--text-muted)] mt-1 block">
            {formatTime(message.timestamp)}
          </span>
        </div>
      </div>
    );
  }

  if (message.type === "error") {
    return (
      <div className="flex justify-center message-appear">
        <div className="flex items-center gap-2 px-4 py-2.5 bg-[var(--error-bg)] border border-[var(--error)]/20 rounded-lg max-w-[80%]">
          <AlertCircle className="w-4 h-4 text-[var(--error)] flex-shrink-0" />
          <p className="text-sm text-[var(--error)]">{message.content}</p>
        </div>
      </div>
    );
  }

  // system
  return (
    <div className="flex justify-center message-appear">
      <div className="flex items-center gap-2 px-4 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-lg">
        <Zap className="w-3.5 h-3.5 text-[var(--text-muted)]" />
        <p className="text-xs text-[var(--text-secondary)]">{message.content}</p>
      </div>
    </div>
  );
}

// ─── Spec Review Content ───

function SpecReviewContent({
  spec,
  onApprove,
  onRegenerate,
  onEdit,
  isCreating,
}: {
  spec: GeneratedSpec;
  onApprove: () => void;
  onRegenerate: () => void;
  onEdit: () => void;
  isCreating: boolean;
}) {
  const isEdp = spec && typeof spec === "object" && "meta" in spec;

  return (
    <div className="space-y-6">
      {/* Spec title (EDP meta or legacy description) */}
      {isEdp && (
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="cyan" className="text-xs">
            {(spec.meta as Record<string, unknown>)?.environment_class as string || "environment"}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {(spec.meta as Record<string, unknown>)?.observation_modality as string || "unknown"}
          </Badge>
          <span className="text-xs text-[var(--text-muted)] ml-auto">
            confidence: {Math.round(((spec.meta as Record<string, unknown>)?.design_confidence as number || 0) * 100)}%
          </span>
        </div>
      )}

      {/* Dynamic spec sections */}
      <div className="space-y-5">
        {isEdp ? (
          <EdpSpecRenderer spec={spec} />
        ) : (
          <LegacySpecRenderer spec={spec} />
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col sm:flex-row gap-3 pt-2 sticky bottom-0 bg-[var(--bg-primary)] pb-2">
        <Button
          onClick={onApprove}
          disabled={isCreating}
          className="flex-1 bg-gradient-to-r from-[var(--accent)] to-[var(--terminal)] hover:shadow-lg"
        >
          {isCreating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Creating...
            </>
          ) : (
            <>
              <CheckCircle2 className="w-4 h-4 mr-2" />
              Approve & Create Environment
            </>
          )}
        </Button>
        <Button
          variant="outline"
          onClick={onRegenerate}
          disabled={isCreating}
          className="flex-1"
        >
          <RotateCcw className="w-4 h-4 mr-2" />
          Regenerate
        </Button>
        <Button
          variant="ghost"
          onClick={onEdit}
          disabled={isCreating}
          className="flex-1"
        >
          <ArrowRight className="w-4 h-4 mr-2" />
          Back to Interview
        </Button>
      </div>
    </div>
  );
}

/** Render an EDP-style spec (meta, environment, output_spec, known_risks, design_decisions, user_intent) */
function EdpSpecRenderer({ spec }: { spec: GeneratedSpec }) {
  return (
    <>
      {/* User Intent */}
      {"user_intent" in spec && spec.user_intent && (
        <SpecSection title="User Intent">
          <ObjectRenderer value={spec.user_intent} />
        </SpecSection>
      )}

      {/* Environment */}
      {"environment" in spec && spec.environment && (
        <SpecSection title="Environment Design">
          <ObjectRenderer value={spec.environment} />
        </SpecSection>
      )}

      {/* Output Spec */}
      {"output_spec" in spec && spec.output_spec && (
        <SpecSection title="Output Specification">
          <ObjectRenderer value={spec.output_spec} />
        </SpecSection>
      )}

      {/* Known Risks */}
      {"known_risks" in spec && Array.isArray(spec.known_risks) && spec.known_risks.length > 0 && (
        <SpecSection title="Known Risks">
          <ul className="space-y-2">
            {spec.known_risks.map((risk: unknown, i: number) => (
              <li key={i} className="p-2 bg-[var(--bg-secondary)] rounded-lg">
                <ObjectRenderer value={risk} />
              </li>
            ))}
          </ul>
        </SpecSection>
      )}

      {/* Design Decisions */}
      {"design_decisions" in spec && Array.isArray(spec.design_decisions) && spec.design_decisions.length > 0 && (
        <SpecSection title="Design Decisions">
          <ul className="space-y-2">
            {spec.design_decisions.map((decision: unknown, i: number) => (
              <li key={i} className="p-2 bg-[var(--bg-secondary)] rounded-lg">
                <ObjectRenderer value={decision} />
              </li>
            ))}
          </ul>
        </SpecSection>
      )}

      {/* Raw fallback for anything else */}
      <SpecSection title="Full Spec (JSON)">
        <pre className="text-xs bg-[var(--bg-secondary)] p-3 rounded-lg overflow-x-auto text-[var(--text-secondary)]">
          {JSON.stringify(spec, null, 2)}
        </pre>
      </SpecSection>
    </>
  );
}

/** Render a legacy flat spec (description, env_class, target_users, etc.) */
function LegacySpecRenderer({ spec }: { spec: GeneratedSpec }) {
  const s = spec as Record<string, unknown>;

  const sections = [
    { title: "Description", value: s.description },
    { title: "Environment Class", value: s.env_class },
    { title: "Target Users", value: s.target_users },
    { title: "Use Cases", value: s.use_cases },
    { title: "Success Criteria", value: s.success_criteria },
    { title: "Constraints", value: s.constraints },
    { title: "Difficulty Level", value: s.difficulty_level },
    { title: "Tags", value: s.tags },
    { title: "Key Components", value: s.key_components },
    { title: "Interaction Model", value: s.interaction_model },
    { title: "Data Requirements", value: s.data_requirements },
    { title: "Testing Strategy", value: s.testing_strategy },
    { title: "Deployment Target", value: s.deployment_target },
    { title: "Performance Requirements", value: s.performance_requirements },
    { title: "Security Considerations", value: s.security_considerations },
    { title: "Integration Points", value: s.integration_points },
    { title: "Maintenance Plan", value: s.maintenance_plan },
  ];

  return (
    <>
      {sections.map(
        (section) =>
          section.value !== undefined && (
            <SpecSection key={section.title} title={section.title}>
              <ValueRenderer value={section.value} />
            </SpecSection>
          )
      )}
    </>
  );
}

/** A collapsible spec section wrapper */
function SpecSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
        {title}
      </h3>
      <div className="pl-1">{children}</div>
      <Separator className="mt-4" />
    </div>
  );
}

/** Recursively render an unknown value */
function ValueRenderer({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-sm text-[var(--text-muted)]">—</span>;
  }
  if (typeof value === "string") {
    return <p className="text-sm text-[var(--text-primary)]">{value}</p>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <p className="text-sm text-[var(--text-primary)]">{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-sm text-[var(--text-muted)]">None</span>;
    return (
      <ul className="list-disc list-inside space-y-1">
        {value.map((item, i) => (
          <li key={i} className="text-sm text-[var(--text-primary)]">
            {typeof item === "string" ? item : <ObjectRenderer value={item} inline />}
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    return <ObjectRenderer value={value} />;
  }
  return <span className="text-sm text-[var(--text-primary)]">{String(value)}</span>;
}

/** Render an object as key-value pairs */
function ObjectRenderer({ value, inline }: { value: unknown; inline?: boolean }) {
  if (!value || typeof value !== "object") return <ValueRenderer value={value} />;

  const obj = value as Record<string, unknown>;
  const entries = Object.entries(obj);

  if (entries.length === 0) return <span className="text-sm text-[var(--text-muted)]">{}</span>;

  if (inline) {
    return (
      <span className="text-sm text-[var(--text-primary)]">
        {entries.map(([k, v]) => `${k}: ${renderInline(v)}`).join(", ")}
      </span>
    );
  }

  return (
    <div className="space-y-1.5">
      {entries.map(([key, val]) => (
        <div key={key} className="flex gap-2">
          <span className="text-xs font-medium text-[var(--text-muted)] min-w-[120px]">{key}:</span>
          <div className="flex-1">
            {typeof val === "object" && val !== null ? (
              Array.isArray(val) ? (
                <ValueRenderer value={val} />
              ) : (
                <div className="pl-3 border-l border-[var(--border-subtle)]">
                  <ObjectRenderer value={val} />
                </div>
              )
            ) : (
              <span className="text-sm text-[var(--text-primary)]">{String(val)}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function renderInline(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") return "{...}";
  return String(value);
}
