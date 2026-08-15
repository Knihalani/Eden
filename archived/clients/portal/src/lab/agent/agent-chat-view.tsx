"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import {
  Check,
  Copy,
  MessageSquare,
  Square,
  X,
} from "lucide-react";
import {
  pinHref,
  suggestionsForPins,
  type AgentContextPin,
  type AgentMessage,
  type AgentThread,
} from "@/lab/fixtures/agent-chat";
import { PinKindChip } from "@/lab/agent/agent-chrome";
import { AgentCitationRow } from "@/lab/agent/agent-citation-chip";
import { AgentActionCards } from "@/lab/agent/agent-action-card";
import { AgentComposer } from "@/lab/agent/agent-composer";
import { SearchInput } from "@/lab/lab-ui";
import { formatSmartTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";

const AgentArtifacts = dynamic(
  () =>
    import("@/lab/agent/agent-artifact").then((m) => ({
      default: m.AgentArtifacts,
    })),
  {
    ssr: false,
    loading: () => (
      <p className="type-meta px-1 py-2 text-[var(--text-faint)]">
        Loading charts…
      </p>
    ),
  },
);

function lastTextPreview(thread: AgentThread): string {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const part = thread.messages[i]?.parts.find((p) => p.type === "text");
    if (part && part.type === "text") return part.text;
  }
  if (thread.pins.length > 0) return thread.pins.map((p) => p.label).join(" · ");
  return "Empty";
}

export function AgentHistoryRail({
  threads,
  activeId,
  query,
  onQueryChange,
  onSelect,
  onNew,
}: {
  threads: AgentThread[];
  activeId: string;
  query: string;
  onQueryChange: (v: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? threads.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.pins.some((p) => p.label.toLowerCase().includes(q)) ||
          lastTextPreview(t).toLowerCase().includes(q),
      )
    : threads;

  return (
    <aside
      className="flex w-full shrink-0 flex-col border-b border-[var(--line)] bg-[var(--bg)] md:h-full md:w-[17rem] md:border-b-0 md:border-r"
      aria-label="Chat history"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2.5">
        <p className="type-label">Conversations</p>
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm"
          onClick={onNew}
        >
          New
        </button>
      </div>
      <div className="border-b border-[var(--line)] px-2.5 py-2">
        <SearchInput
          value={query}
          onChange={onQueryChange}
          placeholder="Search conversations…"
          ariaLabel="Search conversations"
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="px-3 py-5">
            <p className="type-meta text-[var(--text-secondary)]">
              {q ? "No matches." : "No conversations yet."}
            </p>
            {q ? (
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm mt-2"
                onClick={() => onQueryChange("")}
              >
                Clear
              </button>
            ) : null}
          </li>
        ) : (
          filtered.map((t) => {
            const chartCount = t.messages.reduce(
              (n, m) =>
                n +
                m.parts.filter((p) => p.type === "artifacts").reduce((a, p) => {
                  if (p.type !== "artifacts") return a;
                  return a + p.items.filter((i) => i.kind === "chart").length;
                }, 0),
              0,
            );
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onSelect(t.id)}
                  aria-current={t.id === activeId ? "true" : undefined}
                  className={cn(
                    "w-full border-b border-[var(--line)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--accent-muted)]",
                    t.id === activeId &&
                      "bg-[var(--accent-muted)] shadow-[inset_2px_0_0_var(--accent)]",
                  )}
                >
                  <p className="type-ui line-clamp-1 text-[var(--text)]">
                    {t.title}
                  </p>
                  <p className="type-meta mt-0.5 line-clamp-2 leading-snug">
                    {lastTextPreview(t)}
                  </p>
                  <p className="type-meta mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 !text-[0.625rem]">
                    <span>{formatSmartTime(t.updatedAt)}</span>
                    {t.pins.length > 0 ? (
                      <span className="text-[var(--text-faint)]">
                        · {t.pins.length} context
                      </span>
                    ) : null}
                    {chartCount > 0 ? (
                      <span className="text-[var(--text-faint)]">
                        · {chartCount} chart{chartCount === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </p>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </aside>
  );
}

export function AgentContextPins({
  pins,
  onRemove,
}: {
  pins: AgentContextPin[];
  onRemove?: (pin: AgentContextPin) => void;
}) {
  if (pins.length === 0) {
    return (
      <p className="type-meta text-[var(--text-secondary)]">
        No context — Eden can still answer in plain language.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className="type-label">Context</p>
      <ul className="flex flex-wrap gap-1.5" aria-label="Pinned context">
        {pins.map((pin) => (
          <li
            key={`${pin.kind}-${pin.id}`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg-inset)] py-1 pl-1.5 pr-1"
          >
            <PinKindChip kind={pin.kind} />
            <Link
              href={pinHref(pin)}
              className="type-mono max-w-[10rem] truncate !text-[0.6875rem] !text-[var(--text)] hover:text-[var(--accent)] sm:max-w-[14rem]"
              title={pin.label}
            >
              {pin.label}
            </Link>
            {onRemove ? (
              <button
                type="button"
                className="rounded p-0.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)]"
                aria-label={`Remove ${pin.label}`}
                onClick={() => onRemove(pin)}
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoleMark({ role }: { role: "user" | "assistant" }) {
  return (
    <span
      className={cn(
        "type-label flex h-6 w-6 shrink-0 items-center justify-center rounded-full !text-[0.625rem]",
        role === "user"
          ? "bg-[var(--accent-muted)] text-[var(--text)]"
          : "bg-[var(--bg-inset)] text-[var(--accent)] shadow-[0_0_0_1px_var(--line)]",
      )}
      aria-hidden
    >
      {role === "user" ? "You" : "E"}
    </span>
  );
}

function MessageBubble({ message }: { message: AgentMessage }) {
  const isUser = message.role === "user";
  const hasArtifacts = message.parts.some((p) => p.type === "artifacts");
  const citations = message.parts.find((p) => p.type === "citations");
  const actions = message.parts.find((p) => p.type === "actions");
  const artifacts = message.parts.find((p) => p.type === "artifacts");
  const textParts = message.parts.filter((p) => p.type === "text");
  const plainText = textParts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n\n")
    .trim();
  const [copied, setCopied] = useState(false);

  async function copyText() {
    if (!plainText) return;
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  }

  return (
    <article
      className={cn(
        "lab-agent-msg flex gap-2.5",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      <RoleMark role={message.role} />
      <div
        className={cn(
          "group/msg relative min-w-0 px-3.5 py-3",
          isUser
            ? "max-w-[min(34rem,88%)] rounded-[var(--radius-lg)] rounded-tr-sm bg-[var(--accent-muted)]"
            : hasArtifacts
              ? "w-full max-w-[min(52rem,100%)] rounded-[var(--radius-lg)] rounded-tl-sm border border-[var(--line)] bg-[var(--bg)]"
              : "max-w-[min(40rem,88%)] rounded-[var(--radius-lg)] rounded-tl-sm border border-[var(--line)] bg-[var(--bg)]",
        )}
      >
        <p className="type-label mb-1.5 flex items-center gap-1.5">
          <span>{isUser ? "You" : "Eden"}</span>
          <span className="text-[var(--text-faint)]">· {formatSmartTime(message.at)}</span>
          {!isUser && plainText ? (
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--text-faint)] opacity-0 transition-opacity hover:bg-[var(--accent-muted)] hover:text-[var(--text)] group-hover/msg:opacity-100 focus-visible:opacity-100"
              onClick={copyText}
              aria-label={copied ? "Copied" : "Copy reply"}
            >
              {copied ? (
                <Check className="h-3 w-3 text-[var(--success)]" aria-hidden />
              ) : (
                <Copy className="h-3 w-3" aria-hidden />
              )}
              <span className="type-meta !text-[0.625rem]">
                {copied ? "Copied" : "Copy"}
              </span>
            </button>
          ) : null}
        </p>
        {textParts.map((part, i) =>
          part.type === "text" ? (
            <p
              key={i}
              className="type-body whitespace-pre-wrap leading-relaxed text-[var(--text)]"
            >
              {part.text}
            </p>
          ) : null,
        )}
        {artifacts && artifacts.type === "artifacts" ? (
          <AgentArtifacts items={artifacts.items} />
        ) : null}
        {citations && citations.type === "citations" ? (
          <div className="mt-3 space-y-1.5">
            <p className="type-label text-[var(--text-secondary)]">Sources</p>
            <AgentCitationRow items={citations.items} />
          </div>
        ) : null}
        {actions && actions.type === "actions" ? (
          <div className="mt-3 space-y-1.5">
            <p className="type-label text-[var(--text-secondary)]">Next steps</p>
            <AgentActionCards items={actions.items} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ThinkingIndicator({ onStop }: { onStop?: () => void }) {
  return (
    <div
      className="lab-agent-msg flex items-center gap-2.5"
      role="status"
      aria-live="polite"
    >
      <RoleMark role="assistant" />
      <div className="flex items-center gap-3 rounded-[var(--radius-lg)] rounded-tl-sm border border-[var(--line)] bg-[var(--bg)] px-3.5 py-3">
        <span className="type-meta text-[var(--text-secondary)]">
          Working…
        </span>
        <span className="inline-flex gap-1" aria-hidden>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:140ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:280ms]" />
        </span>
        {onStop ? (
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm ml-1"
            onClick={onStop}
          >
            <Square className="h-3 w-3 fill-current" aria-hidden />
            Stop
          </button>
        ) : null}
      </div>
    </div>
  );
}

const CAPABILITIES = [
  { label: "Explain failures", hint: "Traces & issues" },
  { label: "Draft signals", hint: "Detectors" },
  { label: "Chart spend", hint: "PNG / CSV" },
  { label: "Open Improve", hint: "Plans" },
] as const;

export function AgentChatStream({
  thread,
  draft,
  onDraftChange,
  onSend,
  onSuggest,
  onRemovePin,
  thinking,
  onStop,
  composerRef,
}: {
  thread: AgentThread;
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  onSuggest: (prompt: string) => void;
  onRemovePin?: (pin: AgentContextPin) => void;
  thinking: boolean;
  onStop?: () => void;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const empty = thread.messages.length === 0 && !thinking;
  const endRef = useRef<HTMLDivElement>(null);
  const suggestions = suggestionsForPins(thread.pins);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread.id, thread.messages.length, thinking]);

  useEffect(() => {
    if (!thinking || !onStop) return;
    const stop = onStop;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        stop();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [thinking, onStop]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 space-y-3 border-b border-[var(--line)] px-4 py-3.5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <MessageSquare
                className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
                aria-hidden
              />
              <h2 className="type-title truncate text-[var(--text)]">
                {thread.title}
              </h2>
            </div>
            <p className="type-meta">
              {thread.messages.length} message
              {thread.messages.length === 1 ? "" : "s"} ·{" "}
              {formatSmartTime(thread.updatedAt)}
            </p>
          </div>
        </div>
        <AgentContextPins pins={thread.pins} onRemove={onRemovePin} />
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
        {empty ? (
          <div className="mx-auto flex max-w-xl flex-col justify-center py-6 sm:py-12">
            <p className="type-display !text-[1.65rem] tracking-tight text-[var(--text)]">
              What do you need?
            </p>
            <p className="type-body mt-2.5 text-[var(--text-secondary)] leading-relaxed">
              {thread.pins.length > 0
                ? "Context is attached. Ask a question or pick a starter — Eden cites sources and can chart results."
                : "Eden explains runs, drafts detectors, opens Improve plans, and builds downloadable charts from allowlisted queries."}
            </p>

            <ul className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CAPABILITIES.map((c) => (
                <li
                  key={c.label}
                  className="rounded-[var(--radius)] border border-[var(--line)] px-2.5 py-2"
                >
                  <p className="type-meta text-[var(--text)]">{c.label}</p>
                  <p className="type-mono mt-0.5 !text-[0.625rem] !text-[var(--text-faint)]">
                    {c.hint}
                  </p>
                </li>
              ))}
            </ul>

            <ul className="mt-6 space-y-2">
              {suggestions.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    disabled={thinking}
                    className="type-body w-full rounded-[var(--radius-lg)] border border-[var(--line)] px-3.5 py-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
                    onClick={() => onSuggest(p)}
                  >
                    {p}
                  </button>
                </li>
              ))}
            </ul>

            {thread.pins.length === 0 ? (
              <div className="mt-6 flex flex-wrap gap-2">
                <Link href="/traces" className="ds-btn ds-btn-ghost ds-btn-sm">
                  Browse traces
                </Link>
                <Link href="/issues" className="ds-btn ds-btn-ghost ds-btn-sm">
                  Issues
                </Link>
                <Link href="/cost" className="ds-btn ds-btn-ghost ds-btn-sm">
                  Cost
                </Link>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {thread.messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {thinking ? <ThinkingIndicator onStop={onStop} /> : null}
          </>
        )}
        <div ref={endRef} className="h-px w-full shrink-0" aria-hidden />
      </div>

      <AgentComposer
        draft={draft}
        onDraftChange={onDraftChange}
        onSend={onSend}
        onStop={onStop}
        thinking={thinking}
        composerRef={composerRef}
        hasPins={thread.pins.length > 0}
      />
    </div>
  );
}
