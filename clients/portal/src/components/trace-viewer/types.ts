export const TRACE_VIEWER_MODES = [
  { id: "transcript", label: "Transcript" },
  { id: "tree", label: "Tree" },
  { id: "timeline", label: "Timeline" },
  { id: "meta", label: "Metadata" },
  { id: "scores", label: "Scores" },
] as const;

export type DetailMode = (typeof TRACE_VIEWER_MODES)[number]["id"];
