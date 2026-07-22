"use client";

/**
 * AiSessionProvider — global open state, URL sync, keyboard shortcuts.
 * Provides:
 *   - open/close bubble
 *   - ai=1 / ai_prompt / ai_session / ai_autosend URL sync
 *   - ⌘J / Ctrl+J global shortcut
 *   - data-ai-rail-open on <html> for mutual exclusion
 *   - custom events eden:ask-ai / eden:toggle-ai-chat
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { AiContextItem } from "@/lib/context-model";
import { buildContextFromParams, type ContextParamKey } from "@/lib/context-model";
import type { AiMessage } from "./types";

export const AI_OPEN_EVENT = "eden:ask-ai";
export const AI_TOGGLE_EVENT = "eden:toggle-ai-chat";

export interface AiSessionContextValue {
  /** Whether the bubble/panel is open. */
  open: boolean;
  /** Open the AI surface, optionally with a prompt prefill. */
  openAi: (opts?: { prompt?: string; sessionId?: string }) => void;
  /** Close the AI surface (Esc — strips ai=1 / ai_prompt only). */
  closeAi: () => void;
  /** Toggle open/close. */
  toggleAi: () => void;
  /** Active session id. */
  sessionId: string | null;
  setSessionId: (id: string | null) => void;
  /** Attached context. */
  context: AiContextItem[];
  setContext: (items: AiContextItem[]) => void;
  /** Composer draft. */
  draft: string;
  setDraft: (s: string) => void;
  /** Live messages for the current stream. */
  streamMessages: AiMessage[];
  setStreamMessages: React.Dispatch<React.SetStateAction<AiMessage[]>>;
  /** Whether to show the bubble (hide on /agent). */
  showFab: boolean;
}

const AiSessionContext = createContext<AiSessionContextValue | null>(null);

export function useAiSessionContext(): AiSessionContextValue {
  const ctx = useContext(AiSessionContext);
  if (!ctx) throw new Error("useAiSessionContext must be used within AiSessionProvider");
  return ctx;
}

const CONTEXT_PARAM_KEYS: ContextParamKey[] = [
  "traceId",
  "spanId",
  "issueId",
  "findingId",
  "agentId",
  "planId",
  "artifactId",
  "debuggerSessionId",
  "sessionId",
  "alertId",
];

export function AiSessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [context, setContext] = useState<AiContextItem[]>([]);
  const [draft, setDraft] = useState("");
  const [streamMessages, setStreamMessages] = useState<AiMessage[]>([]);

  const showFab = pathname !== "/agent";

  // Parse URL params on mount / when search params change
  useEffect(() => {
    const aiParam = searchParams.get("ai");
    const promptParam = searchParams.get("ai_prompt");
    const sessionParam = searchParams.get("ai_session");

    if (aiParam === "1") {
      setOpen(true);
    }

    if (sessionParam) {
      setSessionId(sessionParam);
    }

    // Build context from current URL identity params
    const paramMap: Partial<Record<ContextParamKey, string>> = {};
    for (const key of CONTEXT_PARAM_KEYS) {
      const val = searchParams.get(key);
      if (val) paramMap[key] = val;
    }
    const items = buildContextFromParams(paramMap);
    if (items.length > 0) {
      setContext(items);
    }

    if (promptParam) {
      setDraft(decodeURIComponent(promptParam));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString()]);

  // data-ai-rail-open for mutual exclusion with mobile nav / cookie banner
  useEffect(() => {
    if (open) {
      document.documentElement.setAttribute("data-ai-rail-open", "1");
    } else {
      document.documentElement.removeAttribute("data-ai-rail-open");
    }
    window.dispatchEvent(
      new CustomEvent("eden:ai-rail-open", { detail: { open } }),
    );
  }, [open]);

  const stripAiParams = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("ai");
    params.delete("ai_prompt");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, router, pathname]);

  const openAi = useCallback(
    (opts?: { prompt?: string; sessionId?: string }) => {
      if (opts?.sessionId) setSessionId(opts.sessionId);
      if (opts?.prompt) setDraft(opts.prompt);
      setOpen(true);
    },
    [],
  );

  const closeAi = useCallback(() => {
    setOpen(false);
    stripAiParams();
  }, [stripAiParams]);

  const toggleAi = useCallback(() => {
    setOpen((prev) => {
      if (prev) stripAiParams();
      return !prev;
    });
  }, [stripAiParams]);

  // ⌘J / Ctrl+J global shortcut
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        if (openRef.current) {
          setOpen(false);
          stripAiParams();
        } else {
          setOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stripAiParams]);

  // Custom events
  useEffect(() => {
    const onAskAi = (e: Event) => {
      const ce = e as CustomEvent<{ prompt?: string; sessionId?: string }>;
      openAi(ce.detail);
    };
    const onToggle = () => toggleAi();
    window.addEventListener(AI_OPEN_EVENT, onAskAi);
    window.addEventListener(AI_TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener(AI_OPEN_EVENT, onAskAi);
      window.removeEventListener(AI_TOGGLE_EVENT, onToggle);
    };
  }, [openAi, toggleAi]);

  const value = useMemo<AiSessionContextValue>(
    () => ({
      open,
      openAi,
      closeAi,
      toggleAi,
      sessionId,
      setSessionId,
      context,
      setContext,
      draft,
      setDraft,
      streamMessages,
      setStreamMessages,
      showFab,
    }),
    [open, openAi, closeAi, toggleAi, sessionId, context, draft, streamMessages, showFab],
  );

  return (
    <AiSessionContext.Provider value={value}>
      {children}
    </AiSessionContext.Provider>
  );
}
