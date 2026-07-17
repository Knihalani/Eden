/**
 * Slash commands + @-mention catalog for ChatSidebar composer (W21).
 */

export type SlashCommand = {
  cmd: string;
  label: string;
  description: string;
  /** Expand typed rest into a full user message (or prefix if rest empty). */
  expand: (rest: string) => string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    cmd: "/filter",
    label: "Filter",
    description: "Propose a U08 list filter",
    expand: (rest) =>
      rest
        ? `Apply this filter on the current list: ${rest}`
        : "Propose a useful filter for the current page based on what you see in page_context.",
  },
  {
    cmd: "/similar",
    label: "Similar",
    description: "Find similar traces",
    expand: (rest) =>
      rest
        ? `Find similar traces for: ${rest}`
        : "Find similar traces to the current page_context (trace_id or filters).",
  },
  {
    cmd: "/export",
    label: "Export",
    description: "Export table CSV/XLSX via export_table",
    expand: (rest) =>
      rest
        ? `Use the export_table tool to export: ${rest}`
        : "Use export_table (CSV preferred) for the current table or slow_traces template.",
  },
  {
    cmd: "/sql",
    label: "SQL",
    description: "Run hardened read-only query_sql",
    expand: (rest) =>
      rest
        ? `Run a read-only query_sql for: ${rest}`
        : "Use query_sql (SELECT/WITH only) for the current page_context; show spend_preview first.",
  },
  {
    cmd: "/alert",
    label: "Alert",
    description: "Preview an NL alert rule",
    expand: (rest) =>
      rest
        ? `Preview an alert rule with preview_nl_alert for: ${rest}`
        : "Use preview_nl_alert to draft an alert rule for the current view (approval required).",
  },
  {
    cmd: "/signal",
    label: "Signal",
    description: "Preview an NL signal",
    expand: (rest) =>
      rest
        ? `Preview a signal with preview_nl_signal for: ${rest}`
        : "Use preview_nl_signal to draft a signal for the current view (approval required).",
  },
  {
    cmd: "/go",
    label: "Go",
    description: "Navigate to a portal page",
    expand: (rest) =>
      rest
        ? `Navigate to ${rest.startsWith("/") ? rest : `/${rest}`}`
        : "Where should I go? Suggest a portal destination for my goal.",
  },
  {
    cmd: "/dataset",
    label: "Dataset",
    description: "List or create a dataset (writes approval-gated)",
    expand: (rest) =>
      rest
        ? `Use list_datasets / create_dataset (approval-gated) for: ${rest}`
        : "List datasets, or create_dataset from the current page_context (approval required).",
  },
  {
    cmd: "/experiment",
    label: "Experiment",
    description: "List / summarize / create experiments",
    expand: (rest) =>
      rest
        ? `Use list_experiments / summarize_experiment / create_experiment for: ${rest}`
        : "List experiments or summarize deltas; create_experiment is approval-gated.",
  },
  {
    cmd: "/playground",
    label: "Playground",
    description: "List or seed a playground from a span",
    expand: (rest) =>
      rest
        ? `Use list_playgrounds / playground_from_span / create_playground for: ${rest}`
        : "List playgrounds or playground_from_span using page_context.trace_id (approval-gated).",
  },
];

export type MentionOption = {
  id: string;
  label: string;
  insert: string;
  description: string;
};

export const MENTION_OPTIONS: MentionOption[] = [
  {
    id: "trace",
    label: "@trace",
    insert: "@trace ",
    description: "Current or selected trace",
  },
  {
    id: "issue",
    label: "@issue",
    insert: "@issue ",
    description: "Current issue context",
  },
  {
    id: "session",
    label: "@session",
    insert: "@session ",
    description: "Current session",
  },
  {
    id: "filter",
    label: "@filter",
    insert: "@filter ",
    description: "Active list filter (q)",
  },
  {
    id: "page",
    label: "@page",
    insert: "@page ",
    description: "Current pathname + resource",
  },
];

/** If input is a slash command line, expand it; otherwise return null. */
export function expandSlashInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.indexOf(" ");
  const cmd = space === -1 ? trimmed.toLowerCase() : trimmed.slice(0, space).toLowerCase();
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
  const match = SLASH_COMMANDS.find((c) => c.cmd === cmd);
  if (!match) return null;
  return match.expand(rest);
}

export function filterSlashCommands(draft: string): SlashCommand[] {
  if (!draft.startsWith("/")) return [];
  const token = draft.split(/\s/)[0]?.toLowerCase() ?? "/";
  return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(token));
}

export function filterMentions(draft: string): MentionOption[] {
  const at = draft.lastIndexOf("@");
  if (at < 0) return [];
  const frag = draft.slice(at);
  if (/\s/.test(frag.slice(1))) return [];
  const prefix = frag.toLowerCase();
  return MENTION_OPTIONS.filter(
    (m) => m.label.startsWith(prefix) || m.id.startsWith(prefix.slice(1)),
  );
}
