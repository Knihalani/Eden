"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getJobStreamUrl } from "@/lib/api";

export interface StreamEvent {
  job_id?: string;
  status?: string;
  current_stage?: string;
  outcome_tier?: string | null;
  stage_history?: Array<{ from?: string; to: string; at: string }>;
  from?: string;
  to?: string;
  at?: string;
}

export interface FileCreatedEvent {
  path: string;
  content?: string;
}

export interface CodeFragmentEvent {
  code: string;
  file_path: string;
}

interface UseJobStreamOptions {
  onStatus?: (data: StreamEvent) => void;
  onStageChange?: (data: string) => void;
  onMessage?: (text: string) => void;
  onFileCreated?: (file: FileCreatedEvent) => void;
  onCodeFragment?: (code: string, filePath: string) => void;
  onComplete?: (data: StreamEvent) => void;
  onError?: (error: string) => void;
  onAgentMessage?: (content: string, agentName?: string) => void;
  onToolCall?: (toolName: string, content: string) => void;
  onWarning?: (text: string) => void;
  onErrorMessage?: (content: string, errorType?: string) => void;
  onCodeGenMessage?: (content: string) => void;
  onEdpPreview?: (content: string) => void;
}

export function useJobStream(
  jobId: string | null,
  options: UseJobStreamOptions = {}
) {
  const {
    onStatus, onStageChange, onMessage, onFileCreated, onCodeFragment,
    onComplete, onError, onAgentMessage, onToolCall, onWarning, onErrorMessage, onCodeGenMessage, onEdpPreview,
  } = options;
  const [connected, setConnected] = useState(false);
  const [latestEvent, setLatestEvent] = useState<StreamEvent | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const stopConnections = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    if (mountedRef.current) {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopConnections();
    };
  }, [stopConnections]);

  useEffect(() => {
    if (!jobId) return;
    stopConnections();

    const url = getJobStreamUrl(jobId);

    try {
      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (mountedRef.current) setConnected(true);
      };

      eventSource.addEventListener("status", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as StreamEvent;
        setLatestEvent(data);
        onStatus?.(data);
      });

      eventSource.addEventListener("stage_change", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as StreamEvent;
        onStageChange?.(data.to || "");
      });

      eventSource.addEventListener("message", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as { text: string };
        onMessage?.(data.text);
      });

      eventSource.addEventListener("file_created", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as FileCreatedEvent;
        onFileCreated?.(data);
      });

      eventSource.addEventListener("code_fragment", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as CodeFragmentEvent;
        onCodeFragment?.(data.code, data.file_path);
      });

      eventSource.addEventListener("complete", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as StreamEvent;
        setLatestEvent((prev) => ({ ...prev, ...data }));
        onComplete?.(data);
        stopConnections();
      });

      eventSource.addEventListener("error", (e) => {
        if (!mountedRef.current) return;
        eventSource.close();
        pollingRef.current = setInterval(async () => {
          if (!mountedRef.current) return;
          try {
            const res = await fetch(`/api/jobs/${jobId}`);
            if (res.ok) {
              const data = await res.json();
              setLatestEvent(data);
              onStatus?.(data);
              if (["completed", "failed", "cancelled", "human_review"].includes(data.status)) {
                onComplete?.(data);
                stopConnections();
              }
            }
          } catch {
            // polling failed, continue
          }
        }, 5000);
      });

      eventSource.addEventListener("agent_message", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as { content: string; agent?: string };
        onAgentMessage?.(data.content, data.agent);
      });

      eventSource.addEventListener("tool_call", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as { tool_name: string; content: string };
        onToolCall?.(data.tool_name, data.content);
      });

      eventSource.addEventListener("warning", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as { text: string };
        onWarning?.(data.text);
      });

      eventSource.addEventListener("error_message", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as { content: string; error_type?: string };
        onErrorMessage?.(data.content, data.error_type);
      });

      eventSource.addEventListener("code_gen", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as { text: string };
        onCodeGenMessage?.(data.text);
      });

      eventSource.addEventListener("edp_preview", (e) => {
        if (!mountedRef.current) return;
        const data = JSON.parse(e.data) as { text: string };
        onEdpPreview?.(data.text);
      });
    } catch {
      onError?.("Failed to connect to stream");
    }

    return stopConnections;
  }, [jobId, onStatus, onStageChange, onMessage, onFileCreated, onCodeFragment, onComplete, onError, onAgentMessage, onToolCall, onWarning, onErrorMessage, onCodeGenMessage, onEdpPreview, stopConnections]);

  return { connected, latestEvent };
}