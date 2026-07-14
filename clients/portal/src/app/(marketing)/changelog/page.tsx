import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/legal-page";

export const metadata: Metadata = {
  title: "Changelog · Eden",
  description: "Product updates for Eden — observability, improvement loop, and platform changes.",
};

const ENTRIES = [
  {
    date: "2026-07-13",
    title: "Soft-launch trust surface",
    body: "Public pricing, about, contact, subprocessors, and CCPA Do Not Sell pages. Real GDPR export/DSAR job pipelines. Portal unit tests wired into CI.",
  },
  {
    date: "2026-07",
    title: "Closed-loop improvements",
    body: "Agent Issues, Improve cockpit, and PR Suggestions continue to close the capture → analyse → ship loop for production LLM apps.",
  },
  {
    date: "2026-06",
    title: "Observability repositioning",
    body: "Eden ships as an observability + improvement platform: OpenAI-compatible gateway, multi-language SDKs, and an org workspace with a cited AI assistant.",
  },
];

export default function ChangelogPage() {
  return (
    <LegalPage
      eyebrow="Changelog"
      title="What shipped"
      description="A calm, chronological record of product changes. Soft launch focuses on reliability and the closed-loop path."
      size="medium"
    >
      <ol className="space-y-10">
        {ENTRIES.map((entry) => (
          <li key={entry.date + entry.title} className="border-l border-[var(--border-subtle)] pl-6">
            <p className="text-[11px] font-mono uppercase tracking-widest text-[var(--text-muted)] mb-1">
              {entry.date}
            </p>
            <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">{entry.title}</h2>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{entry.body}</p>
          </li>
        ))}
      </ol>
    </LegalPage>
  );
}
