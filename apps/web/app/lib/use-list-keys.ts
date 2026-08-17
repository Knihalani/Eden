import { useEffect } from "react";

function typing(t: EventTarget | null) {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

export function useListKeys(ids: string[], selected: string | null, setSel: (id: string) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const inCanvas = e.target instanceof HTMLElement && e.target.closest(".board-scroll");
      if (e.key === "Enter" && !inCanvas) {
        e.preventDefault();
        document.querySelector<HTMLElement>(".board-scroll")?.focus();
        return;
      }
      const down = e.key === "j" || (!inCanvas && e.key === "ArrowDown");
      const up = e.key === "k" || (!inCanvas && e.key === "ArrowUp");
      if (!down && !up) return;
      if (!ids.length) return;
      e.preventDefault();
      const i = ids.indexOf(selected ?? "");
      const from = i < 0 ? 0 : i;
      const next = down ? (from + 1) % ids.length : (from - 1 + ids.length) % ids.length;
      const id = ids[next];
      if (id && id !== selected) setSel(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ids, selected, setSel]);

  useEffect(() => {
    document.querySelector(".row[data-on='true']")?.scrollIntoView({ block: "nearest" });
  }, [selected]);
}
