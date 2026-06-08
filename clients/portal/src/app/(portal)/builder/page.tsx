"use client";

import { useState } from "react";
import Link from "next/link";
import { Sparkles, Box, GitBranch, Settings, AlertCircle } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Visual environment builder (§8.1).
 *
 * MVP scope:
 *   - Drag-and-drop blocks for the high-level stages of an env:
 *     agents, tools, tests, scoring.
 *   - Live preview of the generated spec YAML.
 *   - "Save as draft" → /marketplace submit flow.
 *
 * Design notes:
 *   - We use a node-graph editor (think React Flow). Each block
 *     has typed input/output ports; the graph is the spec.
 *   - The "Submit to Eden" button serialises the graph into the
 *     same spec YAML the `eden generate` CLI accepts, so the
 *     visual builder is a frontend for the existing pipeline.
 *   - Custom node types live in `_components/nodes/` (not in
 *     this file) so they can be loaded lazily.
 *
 * Status: skeleton. Wire the editor + spec translator as the
 * next step in the §8.1 track.
 */
export default function BuilderPage() {
  const [blocks, setBlocks] = useState<number>(0);

  return (
    <div className="p-4 lg:p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Visual builder</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Drag-and-drop your environment together, then submit it to the Eden pipeline.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <BlockCard icon={Box} title="Agents" description="Single-agent, multi-agent, or human-in-the-loop." />
        <BlockCard icon={Settings} title="Tools" description="Built-in tools (shell, file, browser) and custom integrations." />
        <BlockCard icon={GitBranch} title="Scoring" description="Quality, adversarial, and behavioural tests." />
      </div>

      <section
        className="rounded-xl border-2 border-dashed border-[var(--border-default)] bg-[var(--surface)] p-12 text-center"
        aria-label="Drop area for blocks"
      >
        <Sparkles className="w-10 h-10 mx-auto text-[var(--accent)] mb-3" aria-hidden="true" />
        <p className="text-sm font-medium text-[var(--text-primary)]">
          {blocks === 0 ? "No blocks yet. Drag one from the palette above." : `${blocks} block${blocks === 1 ? "" : "s"} in your graph.`}
        </p>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          The editor (React Flow) will be wired here in the next iteration.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setBlocks((b) => b + 1)}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--accent)] text-[var(--bg-base)] hover:opacity-90"
          >
            Add placeholder block
          </button>
          <Link
            href="/docs"
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            Read the spec format
          </Link>
        </div>
      </section>

      <aside
        className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)]/40 p-3 text-xs text-[var(--warning-strong)]"
        role="note"
      >
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <p>
          The visual builder is in skeleton mode (§8.1). The drag-and-drop editor + spec translator
          will land in the next iteration. The text-based{" "}
          <Link href="/jobs/new" className="underline">interview flow</Link> is the recommended
          way to create envs today.
        </p>
      </aside>
    </div>
  );
}

function BlockCard({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4 text-[var(--accent)]" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
      </div>
      <p className="text-xs text-[var(--text-secondary)]">{description}</p>
    </div>
  );
}
