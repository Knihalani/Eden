"use client";

/**
 * /agent — Eden AI Agent workspace.
 * Desktop ≥1280: thread list (~260) | message stream | context panel (~300).
 * Tablet/mobile: sheets for threads + context.
 * Copy: "AI Agent" / "KI-Assistent" — not "Agents".
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, Search, Columns3 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { QueryState } from "@/components/ui/query-state";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ThreadList } from "@/components/ai-agent/thread-list";
import { MessageStream } from "@/components/ai-agent/message-stream";
import { Composer } from "@/components/ai-agent/composer";
import { ContextPanel } from "@/components/ai-agent/context-panel";
import { SuggestedPrompts } from "@/components/ai-agent/suggested-prompts";
import {
  useAiSessionList,
  useAiSessionMessages,
  useAiChat,
  useAiSessionActions,
} from "@/components/ai-agent/use-ai-session";
import { useAiSessionContext } from "@/components/ai-agent/ai-session-provider";
import type { AiMessage, ActionCard } from "@/components/ai-agent/types";
import { buildContextFromParams, type ContextParamKey } from "@/lib/context-model";
import { cn } from "@/lib/utils";

const CONTEXT_PARAMS: ContextParamKey[] = [
  "traceId", "spanId", "issueId", "findingId", "agentId",
  "planId", "artifactId", "debuggerSessionId", "sessionId", "alertId",
];

function AgentPageInner() {
  const t = useTranslations("ai.agent");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { sessionId: globalSessionId, setSessionId: setGlobalSessionId, context: globalContext, setContext } = useAiSessionContext();

  // Derive active session from URL > provider
  const urlSessionId = searchParams.get("ai_session");
  const activeSessionId = urlSessionId ?? globalSessionId;

  const [draft, setDraft] = useState(searchParams.get("ai_prompt") ?? "");
  const [localMessages, setLocalMessages] = useState<AiMessage[]>([]);
  const [streamMessages, setStreamMessages] = useState<AiMessage[]>([]);
  const [threadSheetOpen, setThreadSheetOpen] = useState(false);
  const [contextSheetOpen, setContextSheetOpen] = useState(false);

  // Load context from URL params
  useEffect(() => {
    const paramMap: Partial<Record<ContextParamKey, string>> = {};
    for (const key of CONTEXT_PARAMS) {
      const val = searchParams.get(key);
      if (val) paramMap[key] = val;
    }
    const items = buildContextFromParams(paramMap);
    if (items.length > 0) setContext(items);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const context = globalContext;

  const { data: sessionsData, isLoading: sessionsLoading, error: sessionsError } = useAiSessionList();
  const { data: historyData } = useAiSessionMessages(activeSessionId);
  const { archiveSession } = useAiSessionActions();

  const sessions = sessionsData?.sessions ?? [];

  // Merge history with local messages
  const historyMessages: AiMessage[] = (historyData?.messages ?? []).map((m) => ({
    message_id: m.message_id,
    role: m.role as AiMessage["role"],
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    created_at: m.created_at,
  }));
  const allMessages = [...historyMessages, ...localMessages, ...streamMessages];

  const onMessage = useCallback(
    (msg: AiMessage) => {
      setStreamMessages((prev) => {
        const idx = prev.findIndex((m) => m.message_id === msg.message_id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = msg;
          return next;
        }
        return [...prev, msg];
      });
    },
    [],
  );

  const onDone = useCallback(() => {
    setLocalMessages((prev) => [...prev, ...streamMessages]);
    setStreamMessages([]);
  }, [streamMessages]);

  const { sendMessage, streaming } = useAiChat({
    sessionId: activeSessionId,
    context,
    onSessionId: (id) => {
      setGlobalSessionId(id);
      router.replace(`/agent?ai_session=${encodeURIComponent(id)}`, { scroll: false });
    },
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
    sendMessage(draft);
    setDraft("");
  };

  const handleNewThread = () => {
    setGlobalSessionId(null);
    setLocalMessages([]);
    setStreamMessages([]);
    setDraft("");
    router.push("/agent");
  };

  const handleSelectThread = (sid: string) => {
    setGlobalSessionId(sid);
    setLocalMessages([]);
    setStreamMessages([]);
    router.push(`/agent?ai_session=${encodeURIComponent(sid)}`);
    setThreadSheetOpen(false);
  };

  // ⌘N → new thread
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inForm = target.tagName === "TEXTAREA" || target.tagName === "INPUT";
      if ((e.metaKey || e.ctrlKey) && e.key === "n" && !inForm) {
        e.preventDefault();
        handleNewThread();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const threadListEl = (
    <ThreadList
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelect={handleSelectThread}
      onNew={handleNewThread}
      onArchive={archiveSession}
      className="flex-1"
    />
  );

  const contextPanelEl = (
    <ContextPanel
      items={context}
      onRemove={(i) => setContext(context.filter((_, idx) => idx !== i))}
      className="w-[300px] shrink-0"
    />
  );

  const isEmpty = allMessages.length === 0 && !streaming;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <div className="flex items-center gap-2">
            {/* Threads (tablet/mobile only) */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setThreadSheetOpen(true)}
              className="lg:hidden"
              aria-label={t("threadsAria")}
            >
              <Search className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleNewThread}
              aria-label={t("newThread")}
              aria-keyshortcuts="Meta+N Ctrl+N"
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {t("newThread")}
            </Button>
            {/* Context (tablet/mobile) */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setContextSheetOpen(true)}
              className="lg:hidden"
              aria-label={t("contextAria")}
            >
              <Columns3 className="h-4 w-4" />
            </Button>
          </div>
        }
      />

      {/* Desktop three-column layout */}
      <div className="flex min-h-0 flex-1">
        {/* Thread list — desktop */}
        <div className="hidden w-[260px] shrink-0 lg:flex lg:flex-col">
          {sessionsLoading ? (
            <div className="p-3 text-xs text-[var(--text-muted)]">{t("loadingThreads")}</div>
          ) : sessionsError ? (
            <div className="p-3 text-xs text-[var(--error)]">{t("errorThreads")}</div>
          ) : (
            threadListEl
          )}
        </div>

        {/* Message stream + composer */}
        <div className="flex min-w-0 flex-1 flex-col">
          {isEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4">
              <p className="text-center text-sm text-[var(--text-muted)]">{t("emptyTitle")}</p>
              <p className="text-center text-xs text-[var(--text-faint)]">{t("emptyHint")}</p>
            </div>
          ) : (
            <MessageStream
              messages={allMessages}
              streaming={streaming}
              className="flex-1"
            />
          )}
          {isEmpty && (
            <SuggestedPrompts
              context={context}
              onSelect={(p) => setDraft(p)}
              className="justify-center"
            />
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            streaming={streaming}
          />
        </div>

        {/* Context panel — desktop */}
        <div className="hidden lg:flex">
          {contextPanelEl}
        </div>
      </div>

      {/* Thread sheet — mobile/tablet */}
      <Sheet open={threadSheetOpen} onOpenChange={setThreadSheetOpen}>
        <SheetContent side="left" className="w-[280px] p-0 flex flex-col">
          <SheetHeader className="border-b border-[var(--border-subtle)] p-3">
            <SheetTitle className="text-sm">{t("threadsTitle")}</SheetTitle>
          </SheetHeader>
          {threadListEl}
        </SheetContent>
      </Sheet>

      {/* Context sheet — mobile/tablet */}
      <Sheet open={contextSheetOpen} onOpenChange={setContextSheetOpen}>
        <SheetContent side="right" className="p-0">
          <SheetHeader className="border-b border-[var(--border-subtle)] p-3">
            <SheetTitle className="text-sm">{t("contextTitle")}</SheetTitle>
          </SheetHeader>
          <ContextPanel
            items={context}
            onRemove={(i) => setContext(context.filter((_, idx) => idx !== i))}
            className="border-none"
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default function AgentPage() {
  return (
    <Suspense>
      <AgentPageInner />
    </Suspense>
  );
}
