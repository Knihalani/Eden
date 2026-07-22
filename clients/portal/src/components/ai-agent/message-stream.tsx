"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { CitationChip } from "./citation-chip";
import { ActionCard } from "./action-card";
import type { AiMessage, ActionCard as ActionCardType, ContentPart } from "./types";
import type { CitationTarget } from "@/lib/citation-href";
import { cn } from "@/lib/utils";

interface MessageStreamProps {
  messages: AiMessage[];
  streaming?: boolean;
  onActionConfirm?: (card: ActionCardType) => void;
  className?: string;
}

export function MessageStream({
  messages,
  streaming,
  onActionConfirm,
  className,
}: MessageStreamProps) {
  const t = useTranslations("ai");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  if (messages.length === 0 && !streaming) {
    return (
      <div className={cn("flex flex-1 items-center justify-center", className)}>
        <p className="text-sm text-[var(--text-muted)]">{t("stream.empty")}</p>
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3", className)}
      aria-live="polite"
      aria-label={t("stream.ariaLabel")}
    >
      {messages.map((msg) => (
        <MessageBubble key={msg.message_id} message={msg} onActionConfirm={onActionConfirm} />
      ))}
      {streaming && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--terminal)]">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--terminal)]" aria-hidden />
          {t("stream.thinking")}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({
  message,
  onActionConfirm,
}: {
  message: AiMessage;
  onActionConfirm?: (card: ActionCardType) => void;
}) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-md px-3 py-2 text-sm",
          isUser
            ? "bg-[var(--accent-faint)] text-[var(--text-primary)]"
            : "bg-[var(--bg-inset)] text-[var(--text-primary)]",
        )}
      >
        <MessageContent content={message.content} onActionConfirm={onActionConfirm} />
        {message.streaming && (
          <span className="ml-1 inline-block h-3 w-0.5 animate-pulse bg-[var(--terminal)]" aria-hidden />
        )}
      </div>
    </div>
  );
}

function MessageContent({
  content,
  onActionConfirm,
}: {
  content: AiMessage["content"];
  onActionConfirm?: (card: ActionCardType) => void;
}) {
  if (typeof content === "string") {
    return <p className="whitespace-pre-wrap">{content}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {content.map((part, i) => (
        <MessagePart key={i} part={part} onActionConfirm={onActionConfirm} />
      ))}
    </div>
  );
}

function MessagePart({
  part,
  onActionConfirm,
}: {
  part: ContentPart;
  onActionConfirm?: (card: ActionCardType) => void;
}) {
  if (part.type === "text" && part.text) {
    return <p className="whitespace-pre-wrap">{part.text}</p>;
  }
  if (part.type === "citation" && part.citation) {
    return (
      <CitationChip citation={part.citation as CitationTarget} />
    );
  }
  if (part.type === "action_card" && part.actionCard) {
    return <ActionCard card={part.actionCard} onConfirm={onActionConfirm} />;
  }
  return null;
}
