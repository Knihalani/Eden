"use client";

type Props = {
  labels: string[];
  showCheat: boolean;
};

/** Always-visible compact hotkey strip; expanded cheat when showCheat. */
export function QueueHotkeysStrip({ labels, showCheat }: Props) {
  return (
    <div
      className="mb-space-3 border-y border-[var(--border-subtle)] py-space-2 text-xs text-[var(--text-secondary)]"
      data-wave-e5-labeling="hotkeys"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-[var(--text-primary)]">Hotkeys</span>
        {labels.slice(0, 9).map((l, i) => (
          <span key={l}>
            <kbd className="rounded border border-[var(--border-subtle)] px-1">{i + 1}</kbd> {l}
          </span>
        ))}
        <span>
          <kbd className="rounded border border-[var(--border-subtle)] px-1">⌘</kbd>/
          <kbd className="rounded border border-[var(--border-subtle)] px-1">Ctrl</kbd>+
          <kbd className="rounded border border-[var(--border-subtle)] px-1">Enter</kbd> first
        </span>
        <span>
          <kbd className="rounded border border-[var(--border-subtle)] px-1">S</kbd> skip
        </span>
        <span>
          <kbd className="rounded border border-[var(--border-subtle)] px-1">?</kbd> toggle detail
        </span>
      </div>
      {showCheat ? (
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-[var(--text-muted)]">
          {labels.map((l, i) => (
            <li key={l}>
              <kbd>{i + 1}</kbd> → {l}
            </li>
          ))}
          <li>
            <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> → first label
          </li>
          <li>
            <kbd>S</kbd> skip · <kbd>?</kbd> toggle this sheet
          </li>
        </ul>
      ) : null}
    </div>
  );
}
