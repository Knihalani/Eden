"use client";

/**
 * useAiSession — sessions list + messages + SSE submit via BFF /api/ai-insights/*.
 * Does NOT auto-send. ai_autosend default 0.
 */

import { useCallback, useRef, useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { AiMessage, AiSession, SseEvent } from "./types";
import { serializePageContext } from "@/lib/context-model";
import type { AiContextItem } from "@/lib/context-model";

const SESSION_QUERY_KEY = "ai-sessions";
const MESSAGES_QUERY_KEY = "ai-messages";

export function useAiSessionList() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;

  return useQuery({
    queryKey: [SESSION_QUERY_KEY, orgId],
    queryFn: () => api.listAiInsightsSessions(orgId!),
    enabled: Boolean(orgId),
    staleTime: 30_000,
  });
}

export function useAiSessionMessages(sessionId: string | null) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;

  return useQuery({
    queryKey: [MESSAGES_QUERY_KEY, orgId, sessionId],
    queryFn: () => api.getAiInsightsSessionMessages(orgId!, sessionId!),
    enabled: Boolean(orgId) && Boolean(sessionId),
    staleTime: 10_000,
  });
}

export function useAiSessionActions() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const queryClient = useQueryClient();

  const archiveSession = useCallback(
    async (sessionId: string) => {
      if (!orgId) return;
      await api.archiveAiInsightsSession(orgId, sessionId);
      await queryClient.invalidateQueries({ queryKey: [SESSION_QUERY_KEY, orgId] });
    },
    [orgId, queryClient],
  );

  return { archiveSession };
}

export interface UseAiChatOptions {
  sessionId: string | null;
  context: AiContextItem[];
  onSessionId?: (id: string) => void;
  onMessage?: (msg: AiMessage) => void;
  onDone?: () => void;
  onError?: (err: string) => void;
}

export function useAiChat(opts: UseAiChatOptions) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const abortRef = useRef<AbortController | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!orgId || !content.trim()) return;

      // Cancel any existing stream
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStreaming(true);
      setStreamError(null);

      const pageContext = serializePageContext(opts.context);
      const body = JSON.stringify({
        message: content,
        session_id: opts.sessionId ?? undefined,
        page_context: Object.keys(pageContext).length > 0 ? pageContext : undefined,
      });

      let response: Response;
      try {
        response = await fetch(`/api/ai-insights/chat?org_id=${encodeURIComponent(orgId)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setStreaming(false);
          return;
        }
        const msg = (err as Error).message || "Network error";
        setStreamError(msg);
        opts.onError?.(msg);
        setStreaming(false);
        return;
      }

      if (!response.ok || !response.body) {
        const msg = `Server error: ${response.status}`;
        setStreamError(msg);
        opts.onError?.(msg);
        setStreaming(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Accumulate streaming assistant message
      let assistantText = "";
      let messageId = `stream-${Date.now()}`;
      let resolvedSessionId = opts.sessionId;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let eventType = "";
          let dataLine = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              dataLine = line.slice(6).trim();
            } else if (line === "") {
              if (eventType && dataLine) {
                try {
                  const payload = JSON.parse(dataLine) as Record<string, unknown>;
                  const ev: SseEvent = { event: eventType, data: payload } as SseEvent;

                  if (ev.event === "session_id") {
                    resolvedSessionId = (ev.data as { session_id: string }).session_id;
                    opts.onSessionId?.(resolvedSessionId);
                  } else if (ev.event === "text_delta") {
                    const d = ev.data as { delta: string; message_id?: string };
                    if (d.message_id) messageId = d.message_id;
                    assistantText += d.delta;
                    opts.onMessage?.({
                      message_id: messageId,
                      role: "assistant",
                      content: assistantText,
                      streaming: true,
                    });
                  } else if (ev.event === "done") {
                    if (assistantText) {
                      opts.onMessage?.({
                        message_id: messageId,
                        role: "assistant",
                        content: assistantText,
                        streaming: false,
                      });
                    }
                    opts.onDone?.();
                  } else if (ev.event === "error") {
                    const msg = (ev.data as { detail: string }).detail || "Stream error";
                    setStreamError(msg);
                    opts.onError?.(msg);
                  }
                } catch {
                  // Ignore parse errors on keepalive lines
                }
              }
              eventType = "";
              dataLine = "";
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          const msg = (err as Error).message || "Stream interrupted";
          setStreamError(msg);
          opts.onError?.(msg);
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [orgId, opts],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  return { sendMessage, abort, streaming, streamError };
}
