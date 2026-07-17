"use client";

/**
 * @deprecated Twin sunset (W13) — re-exports MessageCards from transcript-v2.
 * Prefer `@/components/transcript-v2/MessageCards` or `TranscriptV2` for full traces.
 */

export {
  MessageCards as TranscriptView,
  MessageCards,
  type MessageCardsProps as TranscriptViewProps,
  type TranscriptMessage,
  type ToolCall,
} from "@/components/transcript-v2/MessageCards";
