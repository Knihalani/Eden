export const HOTKEY_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export type HotkeyHandlers = {
  labels: string[];
  onApplyLabel: (label: string) => void;
  onSkip: () => void;
  onToggleCheat: () => void;
};

/** Attach labeling queue keyboard shortcuts. Returns cleanup. */
export function bindQueueHotkeys({
  labels,
  onApplyLabel,
  onSkip,
  onToggleCheat,
}: HotkeyHandlers): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "?") {
      onToggleCheat();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && labels[0]) {
      e.preventDefault();
      onApplyLabel(labels[0]);
      return;
    }
    const idx = HOTKEY_LABELS.indexOf(e.key as (typeof HOTKEY_LABELS)[number]);
    if (idx >= 0 && labels[idx]) {
      e.preventDefault();
      onApplyLabel(labels[idx]);
    }
    if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      onSkip();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
