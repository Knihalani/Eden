export const TRACE_VIEWER_MODES = [
  { id: "transcript", label: "Transcript" },
  { id: "timeline", label: "Timeline" },
  { id: "meta", label: "Metadata" },
  { id: "scores", label: "Scores" },
] as const;

/** Canvas modes shown in the segmented control. */
export type CanvasMode = (typeof TRACE_VIEWER_MODES)[number]["id"];

/**
 * URL / API mode. `tree` is a compat alias → Transcript canvas + focus span nav.
 */
export type DetailMode = CanvasMode | "tree";

export function toCanvasMode(mode: DetailMode): CanvasMode {
  return mode === "tree" ? "transcript" : mode;
}
