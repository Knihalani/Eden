"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

function readLocalBool(key: string, fallback: boolean) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

/** Persist boolean in localStorage — only writes on user-driven changes. */
export function usePersistentBool(key: string, initial: boolean) {
  // Match SSR + first client paint; restore stored value before paint.
  const [value, setValueState] = useState(initial);
  const [ready, setReady] = useState(false);
  /** False while restoring stored value — skip open/close transitions. */
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    setAnimate(false);
    setValueState(readLocalBool(key, initial));
    setReady(true);
  }, [key, initial]);

  useEffect(() => {
    if (!ready) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setAnimate(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      setAnimate(false);
    };
  }, [ready, key]);

  const setValue = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValueState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        try {
          localStorage.setItem(key, value ? "1" : "0");
        } catch {
          /* ignore */
        }
        return value;
      });
    },
    [key],
  );

  return [value, setValue, ready, animate] as const;
}

/** Dismissed ids — session scoped, functional updates (no stale sets). */
export function useDismissedSet(storageKey: string) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) setDismissed(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  const persist = useCallback(
    (next: Set<string>) => {
      setDismissed(next);
      try {
        sessionStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );

  const dismiss = useCallback(
    (id: string) => {
      setDismissed((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        try {
          sessionStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [storageKey],
  );

  const dismissMany = useCallback(
    (ids: string[]) => {
      setDismissed((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const id of ids) {
          if (!next.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        if (!changed) return prev;
        try {
          sessionStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [storageKey],
  );

  const restore = useCallback(
    (id?: string) => {
      if (!id) {
        persist(new Set());
        return;
      }
      setDismissed((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        try {
          sessionStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [persist, storageKey],
  );

  return { dismissed, dismiss, dismissMany, restore };
}

function isTypingTarget(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" ||
    t.isContentEditable
  );
}

/** j/k and arrow keys for list navigation. Optional tab shortcuts. */
export function useListKeyboard(options: {
  move: (delta: number) => void;
  onTab?: (tab: "trace" | "signals" | "chat") => void;
  enabled?: boolean;
}) {
  const { move, onTab, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
        return;
      }
      if (onTab) {
        if (e.key === "s") {
          e.preventDefault();
          onTab("signals");
        } else if (e.key === "t") {
          e.preventDefault();
          onTab("trace");
        } else if (e.key === "c") {
          e.preventDefault();
          onTab("chat");
        }
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, move, onTab]);
}
