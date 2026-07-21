"use client";

import * as React from "react";
import Image from "next/image";
import { AlertCircle, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TranscriptToolResult } from "@/lib/observability/types";
import type { TranscriptRow as TR } from "@/lib/observability/types";
import { CollapsedTextWithMore } from "./CollapsedTextWithMore";
import { IoFormatToggle, LazyJson, SectionHeader, type IoViewMode } from "./transcript-panels-a";

export function ToolResultsPanel({ results }: { results: TranscriptToolResult[] }) {
  return (
    <div>
      <SectionHeader>Tool results ({results.length})</SectionHeader>
      <div className="space-y-space-1">
        {results.map((tr, i) => (
          <div
            key={i}
            className={cn(
              "rounded border px-space-2 py-space-2 text-xs",
              tr.is_error
                ? "bg-[var(--error-dim)] border-[var(--error)]"
                : "bg-[var(--bg-secondary)] border-[var(--border-default)]",
            )}
          >
            {tr.is_error && (
              <div className="mb-space-1 flex items-center gap-space-1 text-2xs font-mono uppercase text-[var(--error)]">
                <AlertCircle className="h-3 w-3" /> Error
              </div>
            )}
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-2xs text-[var(--text-secondary)]">
              {typeof tr.content === "string" ? tr.content : <LazyJson value={tr.content ?? null} />}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ImagesPanel({ images }: { images: NonNullable<TR["images"]>; orgId?: string }) {
  return (
    <div>
      <SectionHeader>Images ({images.length})</SectionHeader>
      <div className="flex flex-wrap gap-space-2">
        {images.map((img, i) => (
          <div
            key={i}
            className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] p-space-1"
          >
            {img.url ? (
              <Image
                src={img.url}
                alt={
                  img.content_type?.startsWith("image/")
                    ? "transcript image"
                    : img.content_type || "transcript image"
                }
                width={128}
                height={128}
                unoptimized
                className="h-32 w-32 rounded object-cover"
              />
            ) : (
              <div className="flex h-32 w-32 flex-col items-center justify-center text-2xs text-[var(--text-muted)]">
                <ImageIcon className="mb-space-1 h-5 w-5" />
                <span>{img.content_type || "image"}</span>
                {img.source && <span>{img.source}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function extractResponseText(response: unknown): string | null {
  if (response == null) return null;
  if (typeof response === "string") return response;
  if (typeof response !== "object") return String(response);
  const obj = response as Record<string, unknown>;
  const choices = obj.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const msg = (choices[0] as { message?: { content?: unknown } }).message;
    if (typeof msg?.content === "string" && msg.content.trim()) return msg.content;
  }
  if (typeof obj.content === "string" && obj.content.trim()) return obj.content;
  if (typeof obj.output === "string" && obj.output.trim()) return obj.output;
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
  return null;
}

export function ResponsePanel({ response }: { response: unknown }) {
  const [viewMode, setViewMode] = React.useState<IoViewMode>("formatted");
  const text = extractResponseText(response);
  return (
    <div data-testid="response-panel">
      <div className="mb-space-1 flex flex-wrap items-center justify-between gap-space-2">
        <SectionHeader>Response</SectionHeader>
        <IoFormatToggle value={viewMode} onChange={setViewMode} id="io-format-toggle-output" />
      </div>
      {viewMode === "json" || !text ? (
        <div className="overflow-x-auto rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-space-2 text-2xs">
          <LazyJson value={response} />
        </div>
      ) : (
        <div className="rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-space-2 text-xs text-[var(--text-primary)] leading-relaxed">
          <CollapsedTextWithMore text={text} />
        </div>
      )}
    </div>
  );
}

export function CitationsPanel({ citations }: { citations: NonNullable<TR["citations"]> }) {
  return (
    <div>
      <SectionHeader>Citations ({citations.length})</SectionHeader>
      <ol className="space-y-space-1 text-xs">
        {citations.map((c, i) => (
          <li key={i} className="flex gap-space-2">
            <span className="text-[var(--text-muted)]">{i + 1}.</span>
            <div>
              {c.url ? (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent)] hover:underline"
                >
                  {c.title || c.url}
                </a>
              ) : (
                <span>{c.title || "(no url)"}</span>
              )}
              {c.cited_text && (
                <div className="text-2xs text-[var(--text-muted)] italic">
                  &ldquo;{c.cited_text}&rdquo;
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function LogprobsPanel({
  entries,
}: {
  entries: NonNullable<NonNullable<TR["logprobs"]>["content"]>;
}) {
  return (
    <div>
      <SectionHeader>Top logprobs ({entries.length})</SectionHeader>
      <table className="w-full text-2xs font-mono">
        <thead className="text-[var(--text-muted)]">
          <tr>
            <th className="text-left">Token</th>
            <th className="text-right">Logprob</th>
            <th className="text-right">Bytes</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i} className="border-t border-[var(--border-default)]">
              <td className="text-[var(--text-primary)]">{e.token}</td>
              <td className="text-right tabular-nums">{e.logprob.toFixed(4)}</td>
              <td className="text-right text-[var(--text-muted)]">
                {e.bytes ? `[${e.bytes.slice(0, 6).join(",")}…]` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
