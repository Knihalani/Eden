"use client";

import { useRef, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ComposerProps {
  value: string;
  onChange: (val: string) => void;
  onSend: () => void;
  disabled?: boolean;
  streaming?: boolean;
  placeholder?: string;
  className?: string;
}

export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  streaming,
  placeholder,
  className,
}: ComposerProps) {
  const t = useTranslations("ai.composer");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!disabled && !streaming && value.trim()) {
        onSend();
      }
      return;
    }
    // Shift+Enter → newline (default textarea behavior — no need to intercept)
  };

  return (
    <div className={cn("flex flex-col gap-2 border-t border-[var(--border-subtle)] p-3", className)}>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? t("placeholder")}
        disabled={disabled}
        rows={2}
        className="min-h-[60px] resize-none bg-[var(--bg-inset)] text-sm"
        aria-label={t("ariaLabel")}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--text-muted)]">{t("hint")}</span>
        <Button
          size="sm"
          onClick={onSend}
          disabled={disabled || streaming || !value.trim()}
          className="min-w-16"
          aria-label={t("send")}
        >
          {streaming ? t("sending") : t("send")}
        </Button>
      </div>
    </div>
  );
}
