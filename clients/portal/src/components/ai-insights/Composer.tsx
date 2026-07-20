"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  filterMentions,
  filterSlashCommands,
  type MentionOption,
  type SlashCommand,
} from "./slashCommands";

export interface ComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  sessionCostUsd: number;
  costEstimateUsd?: number | null;
  lastTtftMs?: number | null;
  ttftBudgetMs?: number | null;
  ttftWarning?: string | null;
}

export function Composer({
  input,
  onInputChange,
  onSubmit,
  onStop,
  streaming,
  sessionCostUsd,
  costEstimateUsd,
  lastTtftMs,
  ttftBudgetMs,
  ttftWarning,
}: ComposerProps) {
  const [slashOpen, setSlashOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [slashHits, setSlashHits] = useState<SlashCommand[]>([]);
  const [mentionHits, setMentionHits] = useState<MentionOption[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (streaming) {
      setSlashOpen(false);
      setMentionOpen(false);
      return;
    }
    if (pickerDismissed) {
      setSlashOpen(false);
      setMentionOpen(false);
      return;
    }
    const slash = filterSlashCommands(input);
    const mentions = filterMentions(input);
    if (input.startsWith("/") && !input.includes("\n") && slash.length > 0) {
      setSlashHits(slash);
      setSlashOpen(true);
      setMentionOpen(false);
      setActiveIdx(0);
    } else if (mentions.length > 0) {
      setMentionHits(mentions);
      setMentionOpen(true);
      setSlashOpen(false);
      setActiveIdx(0);
    } else {
      setSlashOpen(false);
      setMentionOpen(false);
    }
  }, [input, streaming, pickerDismissed]);

  const applySlash = (cmd: SlashCommand) => {
    onInputChange(`${cmd.cmd} `);
    setPickerDismissed(false);
    setSlashOpen(false);
    taRef.current?.focus();
  };

  const applyMention = (m: MentionOption) => {
    const at = input.lastIndexOf("@");
    const next = at >= 0 ? `${input.slice(0, at)}${m.insert}` : `${input}${m.insert}`;
    onInputChange(next);
    setPickerDismissed(false);
    setMentionOpen(false);
    taRef.current?.focus();
  };

  const pickerOpen = slashOpen || mentionOpen;
  const pickerItems = slashOpen ? slashHits : mentionHits;
  const pickerLen = pickerItems.length;
  const ttftOver =
    typeof lastTtftMs === "number" &&
    typeof ttftBudgetMs === "number" &&
    lastTtftMs > ttftBudgetMs;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="relative border-t border-[var(--border-default)] p-3"
      data-ai-picker-open={pickerOpen && pickerLen > 0 ? "" : undefined}
    >
      <div className="mb-1.5 flex flex-wrap items-center justify-end gap-2 text-[10px] tabular-nums text-[var(--text-muted)]">
        {typeof costEstimateUsd === "number" && costEstimateUsd > 0 && (
          <span title="Preflight turn estimate">
            Est ≈ ${costEstimateUsd.toFixed(4)}
          </span>
        )}
        <span
          data-session-spend
          title="Session spend meter"
          className="text-[var(--text-secondary)]"
        >
          Session ≈ ${sessionCostUsd.toFixed(4)}
        </span>
        {typeof lastTtftMs === "number" && lastTtftMs > 0 && (
          <span
            data-ttft
            className={ttftOver ? "text-[var(--warning)]" : undefined}
            title={ttftWarning ?? `TTFT budget ${ttftBudgetMs ?? "—"}ms`}
          >
            TTFT {lastTtftMs}ms
            {typeof ttftBudgetMs === "number" ? ` / ${ttftBudgetMs}ms` : ""}
          </span>
        )}
      </div>

      {pickerOpen && pickerLen > 0 && (
        <ul
          role="listbox"
          aria-label={slashOpen ? "Slash commands" : "Mentions"}
          className="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-48 overflow-auto rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] py-1 shadow-lg"
        >
          {slashOpen &&
            slashHits.map((c, i) => (
              <li key={c.cmd} role="option" aria-selected={i === activeIdx}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm",
                    i === activeIdx
                      ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applySlash(c);
                  }}
                >
                  <span className="font-medium text-[var(--accent)]">{c.cmd}</span>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {c.description}
                  </span>
                </button>
              </li>
            ))}
          {mentionOpen &&
            mentionHits.map((m, i) => (
              <li key={m.id} role="option" aria-selected={i === activeIdx}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm",
                    i === activeIdx
                      ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMention(m);
                  }}
                >
                  <span className="font-medium text-[var(--accent)]">{m.label}</span>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {m.description}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => {
            setPickerDismissed(false);
            onInputChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (pickerOpen && pickerLen > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIdx((i) => (i + 1) % pickerLen);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIdx((i) => (i - 1 + pickerLen) % pickerLen);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (slashOpen) applySlash(slashHits[activeIdx]!);
                else applyMention(mentionHits[activeIdx]!);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setPickerDismissed(true);
                setSlashOpen(false);
                setMentionOpen(false);
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                if (slashOpen) applySlash(slashHits[activeIdx]!);
                else applyMention(mentionHits[activeIdx]!);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={2}
          placeholder={
            streaming
              ? "Streaming…"
              : "Ask…  /filter /dataset /go  ·  @trace @issue"
          }
          disabled={streaming}
          aria-label="Ask AI Insights a question"
          aria-disabled={streaming || undefined}
          aria-autocomplete="list"
          className={cn(
            "flex-1 resize-none rounded-md border border-[var(--border-default)]",
            "bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-primary)]",
            "placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]",
            "focus:outline-none disabled:opacity-50",
          )}
        />
        {streaming ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onStop}
            className="h-9 w-9 p-0"
            aria-label="Stop generating"
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="sm"
            disabled={!input.trim()}
            className="h-9 w-9 p-0"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </form>
  );
}
