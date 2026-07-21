"use client";

import dynamic from "next/dynamic";

const ChatSidebar = dynamic(
  () =>
    import("@/components/ai-insights/ChatSidebar").then((m) => ({
      default: m.ChatSidebar,
    })),
  { ssr: false },
);

/** AppShell aiRail host — collapsed by default; Ask AI via header · FAB · ⌘K/⌘J (1A). */
export function AiRailHost({ suppressCoach = false }: { suppressCoach?: boolean }) {
  return (
    <div data-wave11-airail="collapsed-default" data-bottom-layer="ai-fab">
      <ChatSidebar suppressCoach={suppressCoach} />
    </div>
  );
}
