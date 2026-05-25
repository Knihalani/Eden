"use client";

import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Send } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
}

export function ChatInput({ onSend, disabled, placeholder = "Describe the environment you want to create...", maxLength = 4000 }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed && !disabled) {
      onSend(trimmed);
      setValue("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = "48px";
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    if (newValue.length <= maxLength) {
      setValue(newValue);
    }
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [value]);

  return (
    <div className="p-4 bg-white border-t border-gray-100">
      <div className="flex items-end gap-3">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            aria-label={placeholder}
            className={cn(
              "w-full resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400",
              "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent focus:bg-white",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "max-h-[200px] overflow-y-auto"
            )}
            style={{
              height: "auto",
              minHeight: "48px",
            }}
          />
          {maxLength && (
            <span className={cn(
              "absolute bottom-2 right-3 text-xs",
              value.length > maxLength * 0.9 ? "text-amber-500" : "text-gray-400"
            )}>
              {value.length}/{maxLength}
            </span>
          )}
        </div>
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={handleSubmit}
            disabled={disabled || !value.trim()}
            className={cn(
              "flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center transition-all",
              "bg-blue-600 text-white hover:bg-blue-700",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            )}
          >
            <Send className="w-5 h-5" />
          </button>
          <span className="text-xs text-gray-400 flex items-center gap-0.5">
            <kbd className="px-1 py-0.5 bg-gray-100 rounded text-gray-500 text-[10px]">Cmd</kbd>
            <span>+</span>
            <kbd className="px-1 py-0.5 bg-gray-100 rounded text-gray-500 text-[10px]">Enter</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}