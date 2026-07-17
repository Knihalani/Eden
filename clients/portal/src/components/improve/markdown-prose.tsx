"use client";

/**
 * Lightweight markdown renderer for Book/Ledger chapters — no react-markdown dep.
 * Supports headings, lists, bold/italic, inline code, fenced code, and links.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

function inlineFormat(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith("`")) {
      nodes.push(
        <code key={key++} className="rounded bg-[var(--bg-secondary)] px-1 text-[0.9em]">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("[")) {
      const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        nodes.push(
          <a
            key={key++}
            href={link[2]}
            className="text-[var(--accent)] hover:underline"
            target={link[2].startsWith("http") ? "_blank" : undefined}
            rel={link[2].startsWith("http") ? "noopener noreferrer" : undefined}
          >
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(tok);
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MarkdownProse({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre
          key={key++}
          className="my-2 overflow-x-auto rounded-md bg-[var(--bg-secondary)] p-3 text-xs"
          data-lang={lang || undefined}
        >
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      const level = line.match(/^#+/)?.[0].length ?? 1;
      const text = line.replace(/^#+\s*/, "");
      const Tag = (level === 1 ? "h2" : level === 2 ? "h3" : "h4") as "h2" | "h3" | "h4";
      blocks.push(
        <Tag key={key++} className="mt-3 mb-1 font-semibold text-[var(--text-primary)]">
          {inlineFormat(text)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="my-2 list-disc space-y-1 pl-5 text-sm">
          {items.map((it, idx) => (
            <li key={idx}>{inlineFormat(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^#{1,3}\s/.test(lines[i]) && !/^[-*]\s/.test(lines[i]) && !lines[i].startsWith("```")) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="my-1.5 text-sm leading-relaxed text-[var(--text-secondary)]">
        {inlineFormat(para.join(" "))}
      </p>,
    );
  }

  return <div className={cn("prose-eden max-w-none", className)}>{blocks}</div>;
}

/** Build a unified diff string from two plain-text blobs for DiffViewer. */
export function textToUnifiedDiff(oldText: string, newText: string, label = "chapter"): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const out = [`--- a/${label}`, `+++ b/${label}`, `@@ -1,${oldLines.length} +1,${newLines.length} @@`];
  for (const l of oldLines) out.push(`-${l}`);
  for (const l of newLines) out.push(`+${l}`);
  return out.join("\n");
}
