"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { JobRequest } from "@/lib/types";
import { ChatInput } from "./chat-input";
import { Loader2, Sparkles, ArrowRight, Check, Circle, X } from "lucide-react";

interface Message {
  id: string;
  type: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface JobConfig {
  description: string;
  framework: string;
  framework_version: string;
  difficulty_parameters: Record<string, unknown>;
  output_mode: string;
  tags: string[];
}

interface ConfigProgress {
  description: boolean;
  framework: boolean;
  difficulty: boolean;
  output_mode: boolean;
}

const SUGGESTED_PROMPTS = [
  "Build a Python web scraper with BeautifulSoup",
  "Create a Node.js REST API with Express",
  "Make a React component library with TypeScript",
  "Develop a Go microservice with gRPC",
];

// Map user input variations to canonical framework names
const FRAMEWORK_ALIASES: Record<string, string> = {
  next: "nextjs",
  "next.js": "nextjs",
  js: "nodejs",
  ts: "nodejs",
  typescript: "nodejs",
  node: "nodejs",
  "node.js": "nodejs",
  py: "python",
  golang: "go",
  rb: "rust",
  rails: "django",
};

const FRAMEWORKS = ["react", "nextjs", "nodejs", "python", "go", "rust", "django", "fastapi"];

function matchFramework(input: string): string | null {
  const normalized = input.toLowerCase();
  for (const framework of FRAMEWORKS) {
    if (normalized.includes(framework)) return framework;
  }
  for (const [alias, canonical] of Object.entries(FRAMEWORK_ALIASES)) {
    if (normalized.includes(alias)) return canonical;
  }
  return null;
}

function matchDifficulty(input: string): string | null {
  return DIFFICULTY_LEVELS.find((d) => input.toLowerCase().includes(d)) || null;
}

function matchOutputMode(input: string): string | null {
  return OUTPUT_MODES.find((m) => input.toLowerCase().includes(m.replace("-", " "))) || null;
}
const OUTPUT_MODES = ["full-stack", "api-only", "cli-tool", "library"];
const DIFFICULTY_LEVELS = ["beginner", "intermediate", "advanced", "expert"];

const AI_QUESTIONS: Record<string, string> = {
  framework: "What framework or language would you like to use? (e.g., React, Node.js, Python, Go, Rust)",
  difficulty: "What difficulty level should this environment target? (beginner, intermediate, advanced, expert)",
  output_mode: "What output mode best describes your project? (full-stack application, API only, CLI tool, or library)",
  tags: "Any specific requirements or tags to add? (e.g., authentication, database, testing, deployment)",
};

export function ChatCreationView() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [config, setConfig] = useState<JobConfig>({
    description: "",
    framework: "",
    framework_version: "",
    difficulty_parameters: {},
    output_mode: "",
    tags: [],
  });
  const [progress, setProgress] = useState<ConfigProgress>({
    description: false,
    framework: false,
    difficulty: false,
    output_mode: false,
  });
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [currentQuestion, setCurrentQuestion] = useState<string>("framework");
  const [submitState, setSubmitState] = useState<"idle" | "loading" | "success" | "error">("idle");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const bufferRef = useRef<string>("");
  const flushTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isNearBottomRef = useRef(true);
  const flushIntervalMs = 50;

  // Auto-scroll logic
  const scrollToBottom = useCallback(() => {
    if (isNearBottomRef.current && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  // Track if user is near bottom
  const handleScroll = useCallback(() => {
    if (chatContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 100;
    }
  }, []);

  // Batch buffer flush
  const flushBuffer = useCallback(() => {
    if (bufferRef.current) {
      setStreamingContent((prev) => prev + bufferRef.current);
      bufferRef.current = "";
    }
  }, []);

  // Abort any ongoing stream
  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (flushTimeoutRef.current) {
      clearTimeout(flushTimeoutRef.current);
      flushTimeoutRef.current = null;
    }
    setIsStreaming(false);
    // Clear buffer
    bufferRef.current = "";
    setStreamingContent((prev) => {
      if (prev && !prev.endsWith("...")) {
        return prev + "...";
      }
      return prev;
    });
  }, []);

  // Simulate AI response streaming
  const simulateAIResponse = useCallback((questionKey: string) => {
    abortStream();

    const response = AI_QUESTIONS[questionKey];
    if (!response) return;

    const fullResponse = response;
    let index = 0;

    const newAssistantMessage: Message = {
      id: `assistant-${Date.now()}`,
      type: "assistant",
      content: "",
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, newAssistantMessage]);
    setIsStreaming(true);
    setStreamingContent("");

    abortControllerRef.current = new AbortController();

    // Typing indicator delay (200-400ms TTFT)
    const ttftDelay = 200 + Math.random() * 200;

    const streamChunk = () => {
      if (abortControllerRef.current?.signal.aborted) return;

      if (index < fullResponse.length) {
        const chunkSize = Math.floor(Math.random() * 3) + 1;
        bufferRef.current += fullResponse.slice(index, index + chunkSize);
        index += chunkSize;

        // Set up periodic flush
        if (!flushTimeoutRef.current) {
          flushTimeoutRef.current = setTimeout(() => {
            flushBuffer();
            flushTimeoutRef.current = null;
          }, flushIntervalMs);
        }

        const delay = 20 + Math.random() * 30;
        setTimeout(streamChunk, delay);
      } else {
        // Flush any remaining buffer
        if (bufferRef.current) {
          flushBuffer();
        }
        setIsStreaming(false);

        // Update message with final content
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newAssistantMessage.id
              ? { ...m, content: fullResponse }
              : m
          )
        );
      }
    };

    setTimeout(streamChunk, ttftDelay);
  }, [abortStream, flushBuffer]);

  // Handle user message submission
  const handleSendMessage = useCallback((content: string) => {
    // Abort any ongoing stream
    abortStream();

    // Add user message
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      type: "user",
      content,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);

    // Process the user's response and update config
    setConfig((prev) => {
      const newConfig = { ...prev };

      if (currentQuestion === "framework") {
        const matchedFramework = matchFramework(content);
        if (matchedFramework) {
          newConfig.framework = matchedFramework;
          setProgress((p) => ({ ...p, framework: true }));
        }
        newConfig.description = prev.description || content;
        setProgress((p) => ({ ...p, description: true }));
        setCurrentQuestion("difficulty");
      } else if (currentQuestion === "difficulty") {
        const matchedDifficulty = matchDifficulty(content);
        if (matchedDifficulty) {
          newConfig.difficulty_parameters = { level: matchedDifficulty };
          setProgress((p) => ({ ...p, difficulty: true }));
        }
        setCurrentQuestion("output_mode");
      } else if (currentQuestion === "output_mode") {
        const matchedOutputMode = matchOutputMode(content);
        if (matchedOutputMode) {
          newConfig.output_mode = matchedOutputMode;
          setProgress((p) => ({ ...p, output_mode: true }));
        }
        setCurrentQuestion("tags");
      } else if (currentQuestion === "tags") {
        // Parse tags from content
        const tags = content
          .split(/[,;]/)
          .map((t) => t.trim())
          .filter((t) => t.length > 0 && t.length < 30);
        if (tags.length > 0) {
          newConfig.tags = tags;
        }
      }

      return newConfig;
    });

    // Simulate AI asking next question after a delay
    setTimeout(() => {
      if (currentQuestion === "framework") {
        simulateAIResponse("difficulty");
      } else if (currentQuestion === "difficulty") {
        simulateAIResponse("output_mode");
      } else if (currentQuestion === "output_mode") {
        simulateAIResponse("tags");
      } else {
        // Conversation complete
        setCurrentQuestion("complete");
      }
    }, 500);
  }, [abortStream, currentQuestion, simulateAIResponse]);

  // Handle job submission
  const handleSubmitJob = useCallback(async () => {
    if (!config.framework || !config.description) return;

    setSubmitState("loading");

    try {
      const jobData: JobRequest = {
        description: config.description,
        framework: config.framework,
        framework_version: config.framework_version || "latest",
        difficulty_parameters: config.difficulty_parameters,
        output_mode: config.output_mode || "full-stack",
        tags: config.tags,
      };

      const result = await api.submitJob(jobData);
      setSubmitState("success");
      router.push(`/jobs/${result.job_id}`);
    } catch (error) {
      console.error("Failed to submit job:", error);
      setSubmitState("error");
      setTimeout(() => setSubmitState("idle"), 3000);
    }
  }, [config, router]);

  // Scroll on new messages
  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, scrollToBottom]);

  const isConfigComplete = progress.description && progress.framework && progress.difficulty && progress.output_mode;

  // Calculate progress percentage
  const progressPercentage =
    (Number(progress.description) +
     Number(progress.framework) +
     Number(progress.difficulty) +
     Number(progress.output_mode)) /
    4 *
    100;

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left side - Chat Interface (70%) */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-[var(--border)]">
        {/* Chat header */}
        <div className="px-6 py-4 bg-[var(--surface)] border-b border-[var(--border)]">
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">Create New Environment</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-0.5">Describe the environment you want to build</p>
        </div>

        {/* Messages container */}
        <div
          ref={chatContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-6 space-y-6"
        >
          {/* Empty state with welcome message */}
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center -mt-16">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent)] to-cyan-400 flex items-center justify-center mb-6 shadow-lg">
                <Sparkles className="w-8 h-8 text-white" />
              </div>
              <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-2 text-center">
                Tell me what you want to build
              </h2>
              <p className="text-[var(--text-secondary)] text-center mb-8 max-w-md">
                Describe your environment goal in plain language, and I'll help you configure it.
              </p>

              {/* Suggested prompts */}
              <div className="flex flex-col gap-3 w-full max-w-lg">
                <p className="text-sm font-medium text-[var(--text-muted)] text-center">
                  Try one of these examples:
                </p>
                {SUGGESTED_PROMPTS.map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => handleSendMessage(prompt)}
                    className={cn(
                      "text-left px-5 py-3 bg-[var(--surface)] border border-[var(--border)] rounded-xl",
                      "text-sm text-[var(--text-primary)] hover:border-[var(--accent)] hover:bg-[var(--accent-bg)]",
                      "transition-all duration-200 hover:shadow-sm"
                    )}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Rendered messages */}
          {messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "flex gap-3 message-appear",
                message.type === "user" && "flex-row-reverse"
              )}
            >
              {message.type === "user" ? (
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-medium text-blue-600">You</span>
                </div>
              ) : (
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--accent)] to-cyan-400 flex items-center justify-center flex-shrink-0">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
              )}
              <div
                className={cn(
                  "max-w-[75%] rounded-2xl px-4 py-3",
                  message.type === "user"
                    ? "bg-blue-600 text-white rounded-br-md"
                    : "bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] rounded-bl-md"
                )}
              >
                <p className="text-sm leading-relaxed">{message.content}</p>
                <span
                  className={cn(
                    "text-xs mt-1 block",
                    message.type === "user" ? "text-blue-200" : "text-[var(--text-muted)]"
                  )}
                >
                  {message.timestamp.toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                    hour12: true,
                  })}
                </span>
              </div>
            </div>
          ))}

          {/* Streaming indicator */}
          {isStreaming && (
            <div className="flex gap-3 message-appear">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--accent)] to-cyan-400 flex items-center justify-center flex-shrink-0">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl rounded-bl-md px-4 py-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-[var(--accent)] animate-spin" />
                  <span className="text-sm text-[var(--text-muted)]">Thinking...</span>
                </div>
              </div>
            </div>
          )}

          {/* Streaming content */}
          {streamingContent && (
            <div className="flex gap-3 message-appear">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--accent)] to-cyan-400 flex items-center justify-center flex-shrink-0">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl rounded-bl-md px-4 py-3 max-w-[75%]">
                <p className="text-sm leading-relaxed text-[var(--text-primary)]">
                  {streamingContent}
                  <span className="inline-block w-2 h-4 ml-1 bg-[var(--accent)] animate-pulse cursor-blink" />
                </p>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Chat input */}
        <ChatInput
          onSend={handleSendMessage}
          disabled={isStreaming || submitState === "loading"}
          placeholder="Type your message..."
        />
      </div>

      {/* Right side - Job Preview Panel (30%) */}
      <div className="w-[30%] min-w-[300px] bg-[var(--background)] flex flex-col">
        <div className="px-6 py-4 bg-[var(--surface)] border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Job Configuration</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">Your environment settings</p>
        </div>

        {/* Progress section */}
        <div className="px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[var(--text-secondary)]">Progress</span>
            <span className="text-xs font-medium text-[var(--accent)]">{Math.round(progressPercentage)}%</span>
          </div>
          <div className="h-2 bg-[var(--border)] rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-[var(--accent)] to-cyan-400 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
        </div>

        {/* Configuration items */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Description */}
          <ConfigItem
            label="Description"
            value={config.description}
            isComplete={progress.description}
            isActive={currentQuestion === "framework"}
          />

          {!progress.description && (
            <p className="text-xs text-[var(--text-muted)] italic">
              {AI_QUESTIONS.framework}
            </p>
          )}

          {/* Framework */}
          <ConfigItem
            label="Framework"
            value={config.framework || (currentQuestion === "difficulty" ? "Detecting..." : "")}
            isComplete={progress.framework}
            isActive={currentQuestion === "difficulty"}
          />

          {/* Difficulty */}
          <ConfigItem
            label="Difficulty"
            value={
              config.difficulty_parameters?.level
                ? String(config.difficulty_parameters.level).charAt(0).toUpperCase() +
                  String(config.difficulty_parameters.level).slice(1)
                : (currentQuestion === "output_mode" ? "Detecting..." : "")
            }
            isComplete={progress.difficulty}
            isActive={currentQuestion === "output_mode"}
          />

          {/* Output Mode */}
          <ConfigItem
            label="Output Mode"
            value={config.output_mode || (currentQuestion === "tags" ? "Detecting..." : "")}
            isComplete={progress.output_mode}
            isActive={currentQuestion === "tags"}
          />

          {/* Tags */}
          {config.tags.length > 0 && (
            <div className="space-y-2">
              <span className="text-xs font-medium text-[var(--text-secondary)]">Tags</span>
              <div className="flex flex-wrap gap-2">
                {config.tags.map((tag, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-[var(--accent-bg)] text-[var(--accent)] text-xs rounded-full"
                  >
                    {tag}
                    <button
                      onClick={() => setConfig((prev) => ({ ...prev, tags: prev.tags.filter((_, idx) => idx !== i) }))}
                      className="hover:text-[var(--accent-hover)]"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Submit button */}
        <div className="p-6 border-t border-[var(--border)]">
          <button
            onClick={handleSubmitJob}
            disabled={!isConfigComplete || submitState === "loading"}
            className={cn(
              "w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium text-sm",
              "transition-all duration-200",
              isConfigComplete && submitState !== "loading"
                ? "bg-gradient-to-r from-[var(--accent)] to-cyan-400 text-white hover:shadow-lg hover:-translate-y-0.5"
                : "bg-[var(--border)] text-[var(--text-muted)] cursor-not-allowed",
              submitState === "loading" && "opacity-70 cursor-wait"
            )}
          >
            {submitState === "loading" ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating Job...
              </>
            ) : submitState === "success" ? (
              <>
                <Check className="w-4 h-4" />
                Job Created!
              </>
            ) : (
              <>
                Submit Job
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ConfigItemProps {
  label: string;
  value: string;
  isComplete: boolean;
  isActive: boolean;
}

function ConfigItem({ label, value, isComplete, isActive }: ConfigItemProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-[var(--text-secondary)]">{label}</span>
        {isComplete && <Check className="w-3 h-3 text-[var(--success)]" />}
        {isActive && <Circle className="w-3 h-3 text-[var(--accent)] animate-pulse" />}
      </div>
      <div
        className={cn(
          "px-3 py-2 rounded-lg text-sm border",
          isComplete
            ? "bg-[var(--success-bg)] text-[var(--text-primary)] border-[var(--success)]/20"
            : isActive
            ? "bg-[var(--accent-bg)] text-[var(--text-primary)] border-[var(--accent)]/30"
            : "bg-[var(--surface)] text-[var(--text-muted)] border-[var(--border)]"
        )}
      >
        {value || <span className="italic">Not set</span>}
      </div>
    </div>
  );
}
