"use client";

/**
 * Floating AI Agent bubble — compact chat overlay.
 * Mutual exclusion with mobile nav via data-ai-rail-open on <html>.
 * Shares session stack with /agent via AiSessionProvider.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ExternalLink, MessageSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/ai-agent/composer";
import { MessageStream } from "@/components/ai-agent/message-stream";
import { SuggestedPrompts } from "@/components/ai-agent/suggested-prompts";
import {
  useAiSessionContext,
} from "@/components/ai-agent/ai-session-provider";
import {
  useAiChat,
  useAiSessionMessages,
} from "@/components/ai-agent/use-ai-session";
import type { AiMessage } from "@/components/ai-agent/types";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

export function AiBubble() {
  const t = useTranslations("ai.bubble");
  const {
    open,
    openAi,
    closeAi,
    sessionId,
    setSessionId,
    context,
    draft,
    setDraft,
    showFab,
  } = useAiSessionContext();

  const [localMessages, setLocalMessages] = useState<AiMessage[]>([]);
  const [streamMessages, setStreamMessages] = useState<AiMessage[]>([]);

  const { data: historyData } = useAiSessionMessages(open ? sessionId : null);
  const historyMessages: AiMessage[] = (historyData?.messages ?? []).map((m) => ({
    message_id: m.message_id,
    role: m.role as AiMessage["role"],
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    created_at: m.created_at,
  }));
  const allMessages = [...historyMessages, ...localMessages, ...streamMessages];

  const onMessage = useCallback((msg: AiMessage) => {
    setStreamMessages((prev) => {
      const idx = prev.findIndex((m) => m.message_id === msg.message_id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = msg;
        return next;
      }
      return [...prev, msg];
    });
  }, []);

  const onDone = useCallback(() => {
    setLocalMessages((prev) => [...prev, ...streamMessages]);
    setStreamMessages([]);
  }, [streamMessages]);

  const { sendMessage, streaming } = useAiChat({
    sessionId,
    context,
    onSessionId: setSessionId,
    onMessage,
    onDone,
  });

  const handleSend = () => {
    if (!draft.trim()) return;
    const userMsg: AiMessage = {
      message_id: `user-${Date.now()}`,
      role: "user",
      content: draft,
    };
    setLocalMessages((prev) => [...prev, userMsg]);
    void sendMessage(draft);
    setDraft("");
  };

  if (!showFab) return null;

  return (
    <>
      {open ? (
        <div
          className={cn(
            "fixed right-4 z-[var(--z-ai-rail)] flex w-[min(100vw-2rem,380px)] flex-col overflow-hidden rounded-lg",
            "bottom-[var(--ai-fab-bottom)] lg:bottom-6",
            "h-[min(70vh,520px)] border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-xl",
          )}
          role="dialog"
          aria-label={t("title")}
          data-ai-bubble="open"
        >
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
            <p className="text-sm font-medium text-[var(--text-primary)]">{t("title")}</p>
            <div className="flex items-center gap-1">
              <Button type="button" size="sm" variant="ghost" asChild>
                <Link href="/agent" aria-label={t("openFull")}>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={closeAi}
                aria-label={t("close")}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          </div>
          {allMessages.length === 0 && !streaming ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-3">
              <p className="text-center text-xs text-[var(--text-muted)]">{t("empty")}</p>
              <SuggestedPrompts
                context={context}
                onSelect={(p) => setDraft(p)}
                className="justify-center"
              />
            </div>
          ) : (
            <MessageStream
              messages={allMessages}
              streaming={streaming}
              className="flex-1"
            />
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            streaming={streaming}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => openAi()}
          className={cn(
            "fixed right-4 z-[var(--z-ai-fab)] flex h-11 w-11 items-center justify-center rounded-full",
            "bottom-[var(--ai-fab-bottom)] lg:bottom-6",
            "bg-[var(--bg-tertiary)] text-[var(--accent)] shadow-lg ring-1 ring-[var(--border-default)]",
            "hover:bg-[var(--accent-faint)]",
            FOCUS_RING_CLASS,
          )}
          aria-label={t("open")}
          data-ai-bubble="fab"
        >
          <MessageSquare className="h-5 w-5" aria-hidden />
        </button>
      )}
    </>
  );
}
