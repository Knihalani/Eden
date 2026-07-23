"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/lib/utils";

const MIN_H = 24;
const MAX_H = 200;

function resizeTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_H), MAX_H)}px`;
}

/**
 * ChatGPT-style composer: elevated pill, single row, circular ↑.
 * Shell steps above Signal Black page (#212121 on #000).
 */
export function AgentComposer({
  draft,
  onDraftChange,
  onSend,
  onStop,
  thinking,
  composerRef,
  hasPins,
}: {
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  thinking: boolean;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  hasPins: boolean;
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = composerRef ?? localRef;
  const canSend = !thinking && draft.trim().length > 0;

  useLayoutEffect(() => {
    resizeTextarea(ref.current);
  }, [draft, ref]);

  useEffect(() => {
    if (thinking) return;
    const id = window.setTimeout(() => ref.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [thinking, ref]);

  function submit() {
    if (!canSend) return;
    onSend();
  }

  function onFormSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form
      className="agent-composer"
      aria-label="Message Eden"
      data-state={thinking ? "streaming" : "idle"}
      onSubmit={onFormSubmit}
    >
      <div className="agent-composer__shell">
        <label className="sr-only" htmlFor="agent-composer">
          Message Eden
        </label>
        <textarea
          ref={ref}
          id="agent-composer"
          rows={1}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            hasPins ? "Ask about pinned context…" : "Message Eden…"
          }
          className="agent-composer__input"
        />
        {thinking ? (
          <button
            type="button"
            className="agent-composer__action agent-composer__action--stop"
            onClick={onStop}
            aria-label="Stop generating"
          >
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            className={cn(
              "agent-composer__action agent-composer__action--send",
              canSend && "is-armed",
            )}
            disabled={!canSend}
            aria-label="Send message"
          >
            <ArrowUp className="h-5 w-5" strokeWidth={2.25} aria-hidden />
          </button>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {thinking
          ? "Generating. Press Escape to stop."
          : "Press Enter to send, Shift+Enter for a new line."}
      </p>
    </form>
  );
}
